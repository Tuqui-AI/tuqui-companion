import math
import time
from collections import deque, namedtuple
from itertools import islice

from lxml import etree
from odoo import api, models
from odoo.exceptions import ValidationError
from odoo.fields import Domain
from odoo.tools import SQL

from . import search_relevant_text as text
from .search_relevant_config import NORMALIZATION_VERSION

ENGINE = "companion_fts"

DEFAULT_LIMIT = 10
MAX_LIMIT = 50

# Longest query we look at. An agent sends a sentence, not a document.
MAX_QUERY_CHARS = 1000

# Most ranked candidates walked when the final permission check drops records
# (only a model that also filters in Python). Hitting it before ``limit``
# records survive makes the answer ``partial``.
MAX_CANDIDATES = 1000


# The first page of candidates, as a multiple of ``limit``; each following page
# doubles, capped at MAX_WINDOW.
WINDOW_FACTOR = 3
MIN_WINDOW = 30
MAX_WINDOW = 400

# Document frequencies are counted in the user's scope up to this many records
# per term: past it the term is common. Also the cap of ``term_stats.df`` and the
# line between a term that brings in candidates and one that only ranks them.
# At 100k tasks, counting to 2.000 cost ~40 ms per 11-term query; to 500, a quarter.
DF_CAP = 500

# **One weight function, shared with the Tuqui backend**: both sides must weigh
# a term the same way. A word that names the kind of record weighs 0 (it still
# brings in candidates and breaks ties); any other ``ln(1 + population / (df + 1))``,
# ``df`` counted in the user's scope and capped at ``DF_CAP``. The answer carries
# ``population`` and ``term_stats`` so Tuqui computes the same number.

# Longest raw value read per field for the snippet and matched terms: a whole
# mail thread in HTML would otherwise dominate the cost of the answer.
DESCRIBE_MAX_CHARS = 50_000

# Records created after ``sync_cursor`` are matched at search time; past LIVE_MAX
# of them the cron is far behind and the answer is ``partial``.
LIVE_MAX = 200

# ts_rank_cd weights, label D to A (PostgreSQL's defaults). Label A is the record
# name, so a word in the title breaks a tie against one in the body.
RANK_WEIGHTS = "{0.1,0.2,0.4,1.0}"


# The chatter inside a document search: messages that hang from a record of the
# searched model count as part of that record (see ``_answer_with_chatter``).
# At most this many rows of the message index are kept per term (newest first),
# and only rows the user may see count toward it: the user's scope is checked
# inside the walk, before the bound, so nothing the user cannot see moves a
# number of the answer. A word that reaches it has that many visible messages:
# it counts as common (``df`` = ``DF_CAP``), the search uses the rows kept and
# the answer stays ``complete``. Each word keeps its own rows and they are
# scored with every word, so what can be missed is only a document that matches
# through old messages on words that reached it (common ones).
CHATTER_MAX_ROWS = 5_000

# How Odoo decides which access on a document reading its messages takes. A
# model whose class redefines one of these in a module not reviewed below does
# not merge its chatter: the scope rebuilt here could be wider than Odoo's.
CHATTER_GUARDS = (
    "_mail_get_operation_for_mail_message_operation",
    "_mail_group_by_operation_for_mail_message_operation",
)
# ``(module, model)`` of the redefinitions known to leave reading as read access
# on the document. ``calendar.event`` is not here: a private event asks write.
CHATTER_GUARDS_REVIEWED = frozenset(
    {
        ("mail", "base"),
        ("mail", "discuss.channel"),
        ("website_crm_partner_assign", "crm.lead"),
        ("event", "event.event"),
        ("website_forum", "forum.post"),
        ("website_slides", "slide.channel"),
    }
)


def term_weight(df, population, type_word):
    """The weight of one term, shared with Tuqui (see the note above)."""
    if type_word:
        return 0.0
    return round(math.log(1 + population / (min(df, DF_CAP) + 1)), 6)


# One searched term: its tsquery operand (a quoted lexeme, or a prefix with
# ``:*``), the prefix if the term fell back to one, and its weight in the order.
Item = namedtuple("Item", "term operand prefix weight")

# The two sides of a document search with its chatter: the index of the model
# (``allowed``, the records read live) and the index of ``mail.message``, whose
# ``msg_doc`` maps a message id and its index row's date to the document it
# hangs from inside the user's scope (NULL outside it, or for a row older than
# its message). ``live`` is ``[(doc, tsvector)]``, ``msg_live``
# ``[(doc, message id, tsvector)]``; ``msg_skip`` are the message rows read live,
# whose index rows must not answer.
Fused = namedtuple("Fused", "config allowed examined live weights msg_config msg_doc msg_skip msg_live msg_weights")


class _Timings:
    """Milliseconds per phase, only when the caller asks for them."""

    def __init__(self, enabled):
        self.enabled = bool(enabled)
        self.phases = {}
        self._start = self._last = time.perf_counter()

    def mark(self, phase):
        if self.enabled:
            now = time.perf_counter()
            self.phases[phase] = round(self.phases.get(phase, 0) + (now - self._last) * 1000, 1)
            self._last = now

    def report(self):
        return {**self.phases, "total": round((time.perf_counter() - self._start) * 1000, 1)}


def _sort_key(candidate):
    res_id, score, rank = candidate
    return (-score, -rank, -res_id)


def _in_scope(allowed, column, row_date):
    """SQL asking whether ``column`` is in the scope ``_allowed_subquery`` built.

    ``row_date`` is the ``source_write_date`` of the index row being checked,
    for a scope that rejects rows older than their record (the chatter).
    """
    return allowed(column, row_date) if callable(allowed) else SQL("%s IN %s", column, allowed)


def _row_is_current(query, row_date):
    """SQL asking whether an index row of ``mail.message`` dated ``row_date`` is
    not older than its message, the table of ``query``."""
    # An index row older than its message holds text the message may no
    # longer have (an edit racing the cron): it never answers. A NULL
    # write_date (old data) counts as the oldest, on both sides.
    return SQL(
        "COALESCE(%s, '-infinity') <= COALESCE(%s, '-infinity')",
        query.table["write_date"],
        row_date,
    )


class SearchRelevant(models.AbstractModel):
    """Relevance search over the models an administrator enabled.

    Public entry point: :meth:`search_relevant`, which never writes. Consumers
    call it through their own facade (Tuqui: ``tuqui.search``); nothing here
    knows about them.
    """

    _name = "search.relevant"
    _description = "Relevance Search"

    @api.model
    @api.readonly
    def search_relevant(self, model, query, domain=None, limit=DEFAULT_LIMIT, chatter=False):
        """Records of ``model`` that best match ``query``, as the current user sees them.

        **Order.** Candidates are the records with any of the terms (an OR: an
        AND, like ``websearch_to_tsquery``, came back empty for most queries).
        They are ordered by the share of the query's weight they cover (each
        term weighs its rarity in the user's scope, see :func:`term_weight`),
        then ``ts_rank_cd``, then newest first. ``score`` is that share.

        **The chatter.** Only with ``chatter=True``, when ``mail.message`` is
        enabled too and ``model`` has messages: a record also matches through
        the messages that hang from it. It scores what its fields and **one**
        of its messages cover together, and carries ``via``, that message, when
        the message added to the score. How many of its messages match only
        breaks ties. By default the fields only.

        **Permissions.** Candidates are restricted *inside* the ranking query to
        ``env[model]._search(domain)`` as the calling user, so no internal cap
        can starve a narrow domain. Every id is checked again with the user's
        ``search``, for models that also filter in Python. Fields the user
        cannot read do not match, and ``snippet`` and ``matched_terms`` come
        from the user's own ``read``. **Nothing is ranked as the superuser**:
        the chatter is scoped through its documents (:meth:`_chatter_scope`),
        and every ``via`` and every message read live is checked again with the
        user's ``mail.message.search``: if it refuses one, the answer comes
        from the fields alone and is ``partial``.
        Every count in the answer is over records the caller may read, except
        ``population``, the size of the index. None of this depends on how fresh
        the index is: the scope is the user's ``_search`` over current data.

        **Coverage.** ``complete``: the backfill is done, the cron ran within
        ``STALE_AFTER``, and the records created after ``sync_cursor`` were
        matched live. An edit to a record already indexed is picked up by the
        next pass of the cron (about five minutes): until then its old text
        matches, while ``snippet`` and ``matched_terms`` are read from the record
        as it is now. Anything else is ``partial``. ``indexed_until`` is the
        last freshness pass; ``indexed_from`` (only while indexing) is how far
        back the backfill got. ``chatter`` is ``searched`` or ``off``.

        With ``search_relevant_timings`` in the context and an administrator
        calling, the answer carries ``timings``: milliseconds per phase.

        :param str model: technical name of the model to search
        :param str query: natural-language text, as the user would say it
        :param list domain: extra domain, applied as the user
        :param int limit: records to return, at most 50
        :param bool chatter: merge the messages of each record (off by default)
        :returns: ``{"engine", "terms", "term_stats", "population", "coverage":
            {"state", "indexed_until", "fields", "chatter"}, "records": [{"id",
            "score", "matched_terms", "snippet"}]}``. A record matched through
            a message carries ``via``: ``{"model": "mail.message", "id",
            "author", "date", "email_from_outside", "matched_terms",
            "snippet"}``. A record of a model that points at another one — a
            chatter message at its task — carries ``res_model`` and ``res_id``
            too, read as the user like every other value of the answer;
            ``coverage.state`` is ``not_enabled`` (and ``records`` empty) when
            no administrator enabled ``model`` — a signal to use another engine,
            not an error. ``terms`` are the normalized terms searched; empty
            means nothing was searched.
        """
        _ = self.env._
        if not isinstance(model, str) or not model:
            raise ValidationError(_("search_relevant: 'model' must be a model name."))
        if not isinstance(query, str):
            raise ValidationError(_("search_relevant: 'query' must be a string."))
        if domain is None:
            domain = []
        if not isinstance(domain, (list, tuple)):
            raise ValidationError(_("search_relevant: 'domain' must be a list."))
        if isinstance(limit, float) and limit.is_integer():
            limit = int(limit)
        if isinstance(limit, bool) or not isinstance(limit, int):
            raise ValidationError(_("search_relevant: 'limit' must be an integer."))
        limit = min(max(limit, 1), MAX_LIMIT)

        # Administrators only: how long a phase takes grows with rows the
        # caller may not see (the message index holds every model).
        timings = _Timings(self.env.context.get("search_relevant_timings") and self.env.user._is_system())
        result = self._answer(model, query, Domain(list(domain)), limit, bool(chatter), timings)
        if timings.enabled:
            result["timings"] = timings.report()
        return result

    @api.model
    def _answer(self, model, query, domain, limit, chatter, timings):
        terms, _ignored, fallbacks = text.normalize_query(query[:MAX_QUERY_CHARS])
        not_enabled = {
            "engine": ENGINE,
            "terms": terms,
            "coverage": {"state": "not_enabled", "indexed_until": None, "fields": [], "chatter": "off"},
            "term_stats": {},
            "population": 0,
            "records": [],
        }
        if model not in self.env:
            return not_enabled
        records_model = self.env[model]
        # Before looking at the configuration: whether a model is enabled is not
        # something to tell a user who cannot read it.
        records_model.check_access("read")
        config = self.env["search.relevant.config"].sudo().search([("model", "=", model)], limit=1)
        if not config:
            return not_enabled

        readable = [field for field in config._indexed_fields() if records_model._has_field_access(field, "read")]
        coverage = self._coverage(config, readable)
        result = {
            "engine": ENGINE,
            "terms": terms,
            "coverage": coverage,
            "term_stats": {},
            "population": 0,
            "records": [],
        }
        if not terms or not readable:
            return result

        allowed = self._allowed_subquery(config, records_model, domain)
        live_entries, examined, live_overflow = self._live_records(config, records_model, allowed, readable)
        weights = self._readable_weights(config, readable)
        timings.mark("scope")
        chatter_side = self._chatter_side(records_model) if chatter else None
        if chatter_side:
            answer = self._answer_with_chatter(
                result, config, records_model, readable, weights, domain, terms, fallbacks, limit,
                allowed, live_entries, examined, live_overflow, chatter_side, timings,
            )  # fmt: skip
            if answer is not None:
                return answer
            # The user's own search refused a message: answer from the fields alone.
            coverage["state"] = "partial"
        return self._answer_from_fields(
            result, config, records_model, readable, weights, domain, terms, fallbacks, limit,
            allowed, live_entries, examined, live_overflow, timings,
        )  # fmt: skip

    @api.model
    def _answer_from_fields(
        self, result, config, records_model, readable, weights, domain, terms, fallbacks, limit,
        allowed, live_entries, examined, live_overflow, timings,
    ):  # fmt: skip
        """The answer from the fields of ``records_model`` alone."""
        coverage = result["coverage"]
        if fallbacks:
            terms = self._resolve_codes(config, terms, fallbacks, weights, allowed, live_entries, examined)
            result["terms"] = terms
        items, frequencies, term_stats, population = self._search_items(
            config, records_model, terms, weights, allowed, live_entries, examined
        )
        timings.mark("terms")
        live = self._score_live(live_entries, items)
        progress = {"truncated": False}
        window = max(limit * WINDOW_FACTOR, MIN_WINDOW)
        indexed = self._indexed_candidates(config, items, frequencies, weights, allowed, examined, window, progress)
        candidates = self._filter_visible(records_model, self._merge(indexed, live), domain, limit, window)
        visible = candidates[:limit]
        if live_overflow or (progress["truncated"] and len(visible) < limit):
            coverage["state"] = "partial"
        result["term_stats"] = term_stats
        result["population"] = population
        timings.mark("rank")

        found = records_model.browse([candidate[0] for candidate in visible])
        described = self._describe(config, found, items, readable, examined)
        parents = self._parent_values(config, found)
        scores = self._scores(items, visible)
        result["records"] = [
            {
                "id": res_id,
                "score": scores[res_id],
                "matched_terms": described[res_id][0],
                "snippet": described[res_id][1],
                **parents.get(res_id, {}),
            }
            for res_id, _score, _rank in visible
        ]
        timings.mark("describe")
        return result

    # ─── The chatter inside a document search ────────────────────────────

    @api.model
    def _chatter_side(self, records_model):
        """``(config, readable fields)`` of the chatter index when the messages of
        ``records_model`` can be merged into its search, else ``None``.

        No configuration of its own: ``mail.message`` enabled, the model among
        the documents it indexes messages of, Odoo's rule for reading them one
        that was reviewed (:meth:`_chatter_guards_reviewed`), and the user able
        to read messages and at least one indexed field of them.
        """
        name = records_model._name
        if name == "mail.message" or not self._chatter_guards_reviewed(records_model):
            return None
        msg_config = self.env["search.relevant.config"].sudo().search([("model", "=", "mail.message")], limit=1)
        messages = self.env["mail.message"]
        if not msg_config or not messages.has_access("read") or name not in msg_config._chatter_models():
            return None
        msg_readable = [field for field in msg_config._indexed_fields() if messages._has_field_access(field, "read")]
        return (msg_config, msg_readable) if msg_readable else None

    @api.model
    def _chatter_guards_reviewed(self, records_model):
        """Whether every definition of ``CHATTER_GUARDS`` in the class of
        ``records_model`` is in ``CHATTER_GUARDS_REVIEWED``. Fails closed: a
        definition from any other module, or of unknown origin, is not."""
        for cls in type(records_model).__mro__:
            for name in CHATTER_GUARDS:
                method = cls.__dict__.get(name)
                if method is None:
                    continue
                path = (getattr(method, "__module__", None) or "").split(".")
                module = path[2] if len(path) > 2 and path[:2] == ["odoo", "addons"] else None
                if (module, getattr(cls, "_name", None)) not in CHATTER_GUARDS_REVIEWED:
                    return False
        return True

    @api.model
    def _answer_with_chatter(
        self, result, config, records_model, readable, weights, domain, terms, fallbacks, limit,
        allowed, live_entries, examined, live_overflow, chatter_side, timings,
    ):  # fmt: skip
        """The answer when the chatter of ``records_model`` is merged into it.

        Everything the answer counts — ``df``, ``term_stats``, the prefix and
        code decisions, the order, ``score`` and ``via`` — comes from the same
        two sides (:class:`Fused`): the records of the model the user's
        ``_search`` returns, and the messages that hang from them inside the
        whole chatter scope (:meth:`_chatter_query`). ``None``, and nothing
        written in ``result``, when the user's own ``mail.message.search``
        refuses a message read live or a ``via``: the caller then answers from
        the fields alone.
        """
        msg_config, msg_readable = chatter_side
        messages = self.env["mail.message"]
        fused, msg_overflow = self._fused_scope(
            config, records_model, domain, allowed, weights, live_entries, examined, msg_config, msg_readable
        )
        timings.mark("scope")
        if fused is None:
            return None
        searched = terms
        if fallbacks:
            searched = self._resolve_codes(
                config, terms, fallbacks, weights, allowed, live_entries, examined, fused=fused
            )
        items, _frequencies, term_stats, population = self._search_items(
            config, records_model, searched, weights, allowed, live_entries, examined, fused=fused
        )
        timings.mark("terms")
        progress = {"truncated": False}
        window = max(limit * WINDOW_FACTOR, MIN_WINDOW)
        candidates = self._fused_candidates(fused, items, window, progress)
        visible = self._filter_visible(records_model, candidates, domain, limit, window)[:limit]
        timings.mark("rank")
        via_ids = [candidate[4] for candidate in visible if candidate[4]]
        if via_ids and len(messages.search([("id", "in", via_ids)])) < len(set(via_ids)):
            return None
        timings.mark("via_check")

        coverage = result["coverage"]
        msg_coverage = self._coverage(msg_config, msg_readable)
        coverage["chatter"] = "searched"
        coverage["chatter_indexed_until"] = msg_coverage["indexed_until"]
        if (
            msg_coverage["state"] != "complete"
            or live_overflow
            or msg_overflow
            or (progress["truncated"] and len(visible) < limit)
        ):
            coverage["state"] = "partial"
        result["terms"] = searched
        result["term_stats"] = term_stats
        result["population"] = population

        found = records_model.browse([candidate[0] for candidate in visible])
        described = self._describe(config, found, items, readable, examined)
        parents = self._parent_values(config, found)
        vias = self._via_values(msg_config, messages.browse(via_ids), items, msg_readable, fused.msg_skip)
        scores = self._scores(items, visible)
        records = []
        for res_id, _score, _rank, _n_msgs, via in visible:
            record = {
                "id": res_id,
                "score": scores[res_id],
                "matched_terms": described[res_id][0],
                "snippet": described[res_id][1],
                **parents.get(res_id, {}),
            }
            if via:
                record["via"] = vias[via]
            records.append(record)
        result["records"] = records
        timings.mark("describe")
        return result

    @api.model
    def _fused_scope(
        self, config, records_model, domain, allowed, weights, live_entries, examined, msg_config, msg_readable
    ):
        """``(Fused, overflow)``: both sides of the search, as the user, or
        ``(None, overflow)`` when the user's ``mail.message.search`` refuses a
        message that would be read live.

        The messages are the chatter scope with one change: its documents are
        the records of ``records_model`` the fields side searches — the same
        ``_search`` with the same domain, archived ones left out, inside the
        configuration's domain — instead of every model with messages.
        """
        messages = self.env["mail.message"]
        documents = self._document_query(records_model, domain)
        documents.add_where(config._in_domain(documents.table["id"]))
        msg_doc = self._chatter_documents(messages, [(records_model._name, documents)])
        msg_entries, msg_examined, overflow = self._live_records(
            msg_config,
            messages,
            lambda column, row_date: SQL("%s IS NOT NULL", msg_doc(column, row_date)),
            msg_readable,
            confirm=True,
        )
        if msg_entries is None:
            return None, overflow
        parents = {}
        if msg_entries:
            parents = dict(
                self.env.execute_query(
                    SQL(
                        "SELECT id, res_id FROM mail_message WHERE id = ANY(%s)",
                        [message_id for message_id, _parts in msg_entries],
                    )
                )
            )
        live = []
        for res_id, parts in live_entries:
            vector = text.build_tsvector(parts)
            if vector:
                live.append((res_id, vector))
        msg_live = []
        for message_id, parts in msg_entries:
            vector = text.build_tsvector(parts)
            if vector:
                msg_live.append((parents[message_id], message_id, vector))
        fused = Fused(
            config=config,
            allowed=allowed,
            examined=list(examined),
            live=live,
            weights=weights,
            msg_config=msg_config,
            msg_doc=msg_doc,
            msg_skip=sorted(msg_examined),
            msg_live=msg_live,
            msg_weights=self._readable_weights(msg_config, msg_readable),
        )
        return fused, overflow

    @staticmethod
    def _arm_operand(term, prefix, weights):
        """The tsquery operand of a term on one index (``weights`` its readable labels)."""
        if prefix:
            return text.quote_lexeme(prefix) + ":*" + weights
        return text.quote_lexeme(term) + (f":{weights}" if weights else "")

    @staticmethod
    def _live_arrays(rows, width):
        """Columns of ``rows`` as lists, for ``unnest``: ``width`` empty lists when there are none."""
        return [list(column) for column in zip(*rows, strict=True)] if rows else [[] for _n in range(width)]

    @staticmethod
    def _message_walk(fused, operand, on=None):
        """SQL for the rows of the message index that match ``operand``: the
        newest ``CHATTER_MAX_ROWS`` of them **the user may see**, as
        ``(doc, row_id, message_id)``, newest first.

        The scope (``msg_doc``) is checked inside the walk, before the bound:
        the bound counts only visible rows, so rows the user cannot see never
        fill it nor tell how many there are. The rows of the term come from the
        GIN index and are sorted by id alone, and the check per row on the
        primary key runs lazily over that order until the bound is reached.
        ``res_id + 0`` keeps the planner from walking the (config_id, res_id)
        btree backwards to get that order: it would test the tsquery on every
        row of the configuration, not only on the rows of the term. ``OFFSET 0``
        keeps the planner from pushing the check under the sort (it would run on
        every row of the term) and from running it twice per row. ``on``
        switches the walk off for a term (SQL boolean).
        """
        return SQL(
            """
            SELECT s.doc, s.row_id, s.message_id FROM (
                SELECT %(msg_doc)s AS doc, r.row_id, r.message_id FROM (
                    SELECT d.id AS row_id, d.res_id AS message_id, d.source_write_date
                      FROM search_relevant_document d
                     WHERE %(on)s
                       AND d.tsv @@ (%(marker)s::tsquery && %(operand)s::tsquery)
                       AND d.config_id = %(config)s
                       AND d.res_id <> ALL (%(skip)s::int[])
                     ORDER BY d.res_id + 0 DESC
                    OFFSET 0
                ) r
                OFFSET 0
            ) s
             WHERE s.doc IS NOT NULL
             LIMIT %(cap)s
            """,
            msg_doc=fused.msg_doc(SQL.identifier("r", "message_id"), SQL.identifier("r", "source_write_date")),
            on=on if on is not None else SQL("TRUE"),
            marker=text.quote_lexeme(fused.msg_config._marker()),
            operand=operand,
            config=fused.msg_config.id,
            skip=fused.msg_skip,
            cap=CHATTER_MAX_ROWS,
        )

    @api.model
    def _fused_frequencies(self, fused, bases, fields_only=frozenset()):
        """Documents the user may see that match each ``(term, prefix)``, counted up to ``DF_CAP``.

        A document counts once, whether the term is in its fields, in one of its
        messages or in many. The messages are the newest ``CHATTER_MAX_ROWS``
        rows of the message index with the term that the user may see
        (:meth:`_message_walk`): a term with that many visible messages counts
        ``DF_CAP``, a common word, never an absent one. Rows the user cannot see
        change no count. Terms in ``fields_only`` (the ones that weigh 0) are
        not looked for in the messages.
        """
        if not bases:
            return []
        live_docs, live_vectors = self._live_arrays(fused.live, 2)
        msg_live_docs, _msg_live_ids, msg_live_vectors = self._live_arrays(fused.msg_live, 3)
        rows = self.env.execute_query(
            SQL(
                """
                SELECT o.n, c.docs, m.walked
                  FROM unnest(%(fields)s::text[], %(msgs)s::text[], %(plain)s::text[], %(on)s::bool[])
                       WITH ORDINALITY AS o(fop, mop, pop, mon, n)
                 CROSS JOIN LATERAL (
                    SELECT count(*) AS walked, array_agg(DISTINCT x.doc) AS docs FROM (%(walk)s) x
                 ) m
                 CROSS JOIN LATERAL (
                    SELECT count(DISTINCT s.doc) AS docs FROM (
                        (SELECT d.res_id AS doc FROM search_relevant_document d
                          WHERE d.tsv @@ (%(marker)s::tsquery && o.fop::tsquery)
                            AND d.config_id = %(config)s
                            AND %(allowed)s
                            AND d.res_id <> ALL (%(examined)s::int[])
                          LIMIT %(cap)s)
                        UNION ALL
                        SELECT unnest(m.docs)
                        UNION ALL
                        SELECT v.doc FROM unnest(%(live_docs)s::int[], %(live_vectors)s::tsvector[]) AS v(doc, tsv)
                         WHERE v.tsv @@ o.pop::tsquery
                        UNION ALL
                        SELECT v.doc
                          FROM unnest(%(msg_live_docs)s::int[], %(msg_live_vectors)s::tsvector[]) AS v(doc, tsv)
                         WHERE o.mon AND v.tsv @@ o.pop::tsquery
                    ) s
                 ) c
                 ORDER BY o.n
                """,
                fields=[self._arm_operand(term, prefix, fused.weights) for term, prefix in bases],
                msgs=[self._arm_operand(term, prefix, fused.msg_weights) for term, prefix in bases],
                plain=[self._arm_operand(term, prefix, "") for term, prefix in bases],
                on=[term not in fields_only for term, _prefix in bases],
                marker=text.quote_lexeme(fused.config._marker()),
                config=fused.config.id,
                allowed=_in_scope(
                    fused.allowed, SQL.identifier("d", "res_id"), SQL.identifier("d", "source_write_date")
                ),
                examined=fused.examined,
                cap=DF_CAP,
                walk=self._message_walk(fused, SQL.identifier("o", "mop"), SQL.identifier("o", "mon")),
                live_docs=live_docs,
                live_vectors=live_vectors,
                msg_live_docs=msg_live_docs,
                msg_live_vectors=msg_live_vectors,
            )
        )
        # As many visible messages as the bound: common, never absent (nor retried by prefix).
        return [DF_CAP if walked >= CHATTER_MAX_ROWS else min(docs, DF_CAP) for _n, docs, walked in rows]

    @api.model
    def _fused_candidates(self, fused, items, first_page, progress):
        """Ranked ``(doc, score, rank, n_msgs, via)``, fetched lazily in pages."""
        offset, size = 0, first_page
        while offset < MAX_CANDIDATES:
            size = min(size, MAX_CANDIDATES - offset)
            page = self._fused_page(fused, items, offset, size)
            yield from page
            if len(page) < size:
                return
            offset += size
            size = min(size * 2, MAX_WINDOW)
        progress["truncated"] = True

    @api.model
    def _fused_page(self, fused, items, offset, count):
        """``[(doc, score, rank, n_msgs, via)]`` at positions ``[offset, offset + count)``.

        A document scores what its fields and its best message cover together:
        each term counts once, found in either. Other messages never add to it;
        how many matched (``n_msgs``) only breaks ties, after ``ts_rank_cd`` of
        the fields. ``via`` is that message when it covers a term the fields do
        not. ``ts_rank_cd`` is computed only for the top tier, as in
        :meth:`_rank_page`.

        Terms that weigh 0 are not looked for in the messages: they could not
        add to any score. For each term on its own, the newest
        ``CHATTER_MAX_ROWS`` rows of the message index the user may see are
        kept (:meth:`_message_walk`, as in :meth:`_fused_frequencies`); only
        index rows not older than their message count. A common term never
        takes the rows of a rare one, and rows the user cannot see never take
        the place of visible ones. The bound leaves the answer ``complete``:
        what it can miss is a document that matches only through old messages
        on words with that many visible messages.
        """
        size = len(items)
        weighed = [n for n, item in enumerate(items) if item.weight > 0]
        field_ops = [self._arm_operand(item.term, item.prefix, fused.weights) for item in items]
        msg_ops = [self._arm_operand(items[n].term, items[n].prefix, fused.msg_weights) for n in weighed]
        plain_ops = [self._plain_operand(item) for item in items]
        msg_plain_ops = [plain_ops[n] for n in weighed]

        def hits(vector, operands):
            return SQL("ARRAY[%s]", SQL(", ").join(SQL("(%s @@ %s::tsquery)::int", vector, op) for op in operands))

        def weighted(parts):
            return SQL(" + ").join(
                SQL("%s::float8 * %s", item.weight, part) for item, part in zip(items, parts, strict=True)
            )

        fields_score = weighted([SQL("COALESCE(f.hits[%s], 0)", n) for n in range(1, size + 1)])
        message_hit = {n: k for k, n in enumerate(weighed, 1)}
        fused_score = weighted(
            [
                SQL("GREATEST(COALESCE(f.hits[%s], 0), m.hits[%s])", n + 1, message_hit[n])
                if n in message_hit
                else SQL("COALESCE(f.hits[%s], 0)", n + 1)
                for n in range(size)
            ]
        )
        live_docs, live_vectors = self._live_arrays(fused.live, 2)
        msg_live_docs, msg_live_ids, msg_live_vectors = self._live_arrays(fused.msg_live, 3)
        index_vector = SQL.identifier("d", "tsv")
        live_vector = SQL.identifier("v", "tsv")
        field_any = " | ".join(field_ops)
        plain_any = " | ".join(plain_ops)
        if weighed:
            walked = SQL.identifier("wd", "tsv")
            messages = SQL(
                """
                SELECT w.doc, w.message_id, %(msg_hits)s AS hits
                  FROM (
                    SELECT DISTINCT ON (t.message_id) t.doc, t.message_id, t.row_id
                      FROM unnest(%(msg_ops_array)s::text[]) AS o(op)
                     CROSS JOIN LATERAL (%(walk)s) t
                     ORDER BY t.message_id
                  ) w
                  JOIN search_relevant_document wd ON wd.id = w.row_id
                UNION ALL
                SELECT v.doc, v.message_id, %(msg_live_hits)s
                  FROM unnest(%(msg_live_docs)s::int[], %(msg_live_ids)s::int[], %(msg_live_vectors)s::tsvector[])
                       AS v(doc, message_id, tsv)
                 WHERE v.tsv @@ %(msg_plain_any)s::tsquery
                """,
                msg_hits=hits(walked, msg_ops),
                msg_ops_array=msg_ops,
                walk=self._message_walk(fused, SQL.identifier("o", "op")),
                msg_live_hits=hits(live_vector, msg_plain_ops),
                msg_live_docs=msg_live_docs,
                msg_live_ids=msg_live_ids,
                msg_live_vectors=msg_live_vectors,
                msg_plain_any=" | ".join(msg_plain_ops),
            )
        else:
            messages = SQL("SELECT NULL::int AS doc, NULL::int AS message_id, NULL::int[] AS hits WHERE FALSE")
        return self.env.execute_query(
            SQL(
                """
                WITH fld AS MATERIALIZED (
                    SELECT d.res_id AS doc, d.id AS row_id, NULL::tsvector AS live_tsv, %(field_hits)s AS hits
                      FROM search_relevant_document d
                     WHERE d.tsv @@ %(field_query)s::tsquery
                       AND d.config_id = %(config)s
                       AND %(allowed)s
                       AND d.res_id <> ALL (%(examined)s::int[])
                    UNION ALL
                    SELECT v.doc, NULL, v.tsv, %(live_hits)s
                      FROM unnest(%(live_docs)s::int[], %(live_vectors)s::tsvector[]) AS v(doc, tsv)
                     WHERE v.tsv @@ %(plain_any)s::tsquery
                ), msg AS MATERIALIZED (
                    %(messages)s
                ), best AS (
                    SELECT DISTINCT ON (m.doc) m.doc, m.message_id, %(fused_score)s AS score,
                           count(*) OVER (PARTITION BY m.doc) AS n_msgs
                      FROM msg m LEFT JOIN fld f ON f.doc = m.doc
                     ORDER BY m.doc, score DESC, m.message_id DESC
                ), docs AS MATERIALIZED (
                    SELECT COALESCE(f.doc, b.doc) AS doc, f.row_id, f.live_tsv,
                           GREATEST(b.score, %(fields_score)s) AS score,
                           CASE WHEN b.score > %(fields_score)s THEN b.message_id END AS via,
                           COALESCE(b.n_msgs, 0) AS n_msgs
                      FROM fld f FULL JOIN best b ON b.doc = f.doc
                ), tier AS (
                    SELECT COALESCE(
                        (SELECT score FROM docs ORDER BY score DESC OFFSET %(last)s LIMIT 1), 0
                    ) AS floor
                )
                SELECT r.doc, r.score,
                       COALESCE(
                           ts_rank_cd(%(rank_weights)s::float4[], d.tsv, %(field_any)s::tsquery, 33),
                           ts_rank_cd(%(rank_weights)s::float4[], r.live_tsv, %(plain_any)s::tsquery, 33),
                           0
                       ) AS rank,
                       r.n_msgs, r.via
                  FROM docs r LEFT JOIN search_relevant_document d ON d.id = r.row_id
                 WHERE r.score >= (SELECT floor FROM tier)
                 ORDER BY r.score DESC, rank DESC, r.n_msgs DESC, r.doc DESC
                OFFSET %(offset)s LIMIT %(count)s
                """,
                field_hits=hits(index_vector, field_ops),
                live_hits=hits(live_vector, plain_ops),
                field_query=f"{text.quote_lexeme(fused.config._marker())} & ({field_any})",
                config=fused.config.id,
                allowed=_in_scope(
                    fused.allowed, SQL.identifier("d", "res_id"), SQL.identifier("d", "source_write_date")
                ),
                examined=fused.examined,
                live_docs=live_docs,
                live_vectors=live_vectors,
                plain_any=plain_any,
                messages=messages,
                fused_score=fused_score,
                fields_score=fields_score,
                last=offset + count - 1,
                rank_weights=RANK_WEIGHTS,
                field_any=field_any,
                offset=offset,
                count=count,
            )
        )

    @api.model
    def _via_values(self, msg_config, messages, items, msg_readable, msg_examined):
        """``{message id: via}`` for the messages that brought their document in, read as the user."""
        if not messages:
            return {}
        described = self._describe(msg_config, messages, items, msg_readable, msg_examined)
        wanted = [
            name
            for name in ("author_id", "email_from", "date", "message_type")
            if messages._has_field_access(messages._fields[name], "read")
        ]
        values = {}
        for row in messages.read(wanted):
            author = row.get("author_id")
            date = row.get("date")
            values[row["id"]] = {
                "model": "mail.message",
                "id": row["id"],
                "author": author[1] if author else (row.get("email_from") or None),
                "date": date.strftime("%Y-%m-%dT%H:%M:%SZ") if date else None,
                # A mail that arrived, not something written in Odoo: its text
                # is data, never an instruction to whoever reads the answer.
                "email_from_outside": row.get("message_type") == "email",
                "matched_terms": described[row["id"]][0],
                "snippet": described[row["id"]][1],
            }
        return values

    # ─── Coverage & fields ───────────────────────────────────────────────

    @api.model
    def _coverage(self, config, readable):
        watermark = config.sync_watermark
        partial = (
            bool(config.backfill_cursor)
            or config.normalization != NORMALIZATION_VERSION
            or not config._layout_intact()
            or config._is_stale()
        )
        coverage = {
            "state": "partial" if partial else "complete",
            "indexed_until": watermark.strftime("%Y-%m-%dT%H:%M:%SZ") if watermark else None,
            "fields": [field.name for field in readable],
            "chatter": "off",
        }
        if config.backfill_cursor and config.backfill_reached:
            coverage["indexed_from"] = config.backfill_reached.strftime("%Y-%m-%dT%H:%M:%SZ")
        return coverage

    @api.model
    def _readable_weights(self, config, readable):
        """Weight labels to search: ``""`` (all of them) when every field of the
        layout is there and readable, else only the labels of readable fields."""
        weights = config._weight_map()
        names = {field.name for field in readable}
        if set(weights) == names:
            return ""
        return "".join(weight for name, weight in weights.items() if name in names)

    # ─── Candidates ──────────────────────────────────────────────────────

    @api.model
    def _allowed_subquery(self, config, records_model, domain):
        """The records the user may get, from the user's own ``_search`` (the
        chatter: :meth:`_chatter_scope`). A subquery for ``IN``, or a function
        of the id column that builds the check (see :func:`_in_scope`).
        """
        # mail.message filters in Python after its SQL, so its _search does not
        # compose into the ranking query: Odoo's rule for a message is rebuilt here.
        if records_model._name == "mail.message":
            return self._chatter_scope(records_model, domain, config._chatter_models())
        return self._document_query(records_model, domain).subselect()

    @api.model
    def _document_query(self, records_model, domain):
        """The records of a model the user may get: their ``_search`` with
        ``domain``, narrowed like the documents of the chatter
        (:meth:`_chatter_document_domain`), so a record and its messages are
        searched through one scope."""
        return records_model._search(domain & Domain(self._chatter_document_domain(records_model._name)))

    @api.model
    def _chatter_scope(self, messages, domain, documents_models):
        """The messages the user may read, as SQL that composes into the ranking query.

        ``mail.message._search`` filters in Python and materializes every
        matching id (out of memory on a real database), so its rule for a
        message of a document (``mail/models/mail_message.py``) is rebuilt
        here, each piece as the user:

        * the caller's domain, via ``_search(bypass_access=True)``: a path like
          ``parent_id.body`` still goes through the related model's rules;
        * ``mail.message``'s record rules, which ``bypass_access`` skips too;
        * never a ``user_notification``;
        * a document of ``documents_models`` the user may read, from that
          model's own ``_search`` (archived included), narrowed where reading
          the document is not enough (:meth:`_chatter_document_domain`);
        * for a user who is not internal, Odoo's share filter.

        Narrower than Odoo on purpose: a message read only as author or
        recipient, on a document the user cannot open, is not a candidate. So
        every candidate is one ``mail.message.search`` would return, and no
        count or order can reveal another one.

        A check per candidate on the primary key, not a subquery for ``IN``: an
        internal user's scope is millions of messages, and the planner hashed
        all of them (4 s) to keep a few dozen. ``EXISTS`` got the same
        semi-join; a scalar subquery with ``LIMIT`` is not pulled up.
        """
        documents = []
        for name in documents_models:
            if name not in self.env or not self.env[name].has_access("read"):
                continue
            parents = self.env[name].with_context(active_test=False)._search(self._chatter_document_domain(name))
            documents.append((name, parents))
        query = self._chatter_query(messages, domain, documents)
        if query is None:
            return lambda _column, _row_date: SQL("FALSE")
        return lambda id_column, row_date: SQL(
            "(SELECT TRUE FROM %s WHERE %s = %s AND %s AND %s LIMIT 1) IS NOT NULL",
            query.from_clause,
            query.table["id"],
            id_column,
            query.where_clause,
            _row_is_current(query, row_date),
        )

    @api.model
    def _chatter_documents(self, messages, documents):
        """The same scope as :meth:`_chatter_scope`, for given ``documents``: a
        function of a message id column that gives the document it hangs from,
        or NULL when the message is out of the user's scope or ``row_date`` (the
        index row's ``source_write_date``) is older than the message."""
        query = self._chatter_query(messages, [], documents)
        if query is None:
            return lambda _column, _row_date: SQL("NULL::int")
        return lambda id_column, row_date: SQL(
            "(SELECT %s FROM %s WHERE %s = %s AND %s AND %s LIMIT 1)",
            query.table["res_id"],
            query.from_clause,
            query.table["id"],
            id_column,
            query.where_clause,
            _row_is_current(query, row_date),
        )

    @api.model
    def _chatter_query(self, messages, domain, documents):
        """The messages the user may read among the ones of ``documents``
        (``[(model name, Query of its records)]``), as a ``Query``, or ``None``
        when there are none. Every piece of :meth:`_chatter_scope` but the
        choice of documents."""
        query = messages._search(domain, bypass_access=True)
        table = query.table
        column = lambda name: table[name]  # noqa: E731
        as_rules = messages.sudo().with_context(active_test=False)
        # The document check is ours: keep only the accesses added on top of Odoo's res_access_read.
        rules = Domain.TRUE if self.env.su else self.env[messages._name]._access_domain("read")
        rules = rules.map_conditions(
            lambda cond: Domain.TRUE if cond.field_expr == "res_access_read" else cond
        ).optimize_full(as_rules)
        if rules.is_false() or query.is_empty() or not documents:
            return None
        if not rules.is_true():
            query.add_where(rules._to_sql(table._with_model(as_rules)))
        query.add_where(SQL("%s <> 'user_notification'", column("message_type")))
        query.add_where(
            SQL(
                "(%s)",
                SQL(" OR ").join(
                    SQL("(%s = %s AND %s IN %s)", column("model"), name, column("res_id"), parents.subselect())
                    for name, parents in documents
                ),
            )
        )
        if not self.env.user._is_internal():
            query.add_where(
                SQL(
                    "%s IS NOT TRUE AND %s IN (SELECT id FROM mail_message_subtype WHERE internal IS NOT TRUE)"
                    " AND %s <> 'tracking'",
                    column("is_internal"),
                    column("subtype_id"),
                    column("message_type"),
                )
            )
        return query

    @api.model
    def _chatter_document_domain(self, name):
        """What narrows the documents of ``name`` beyond their record rules.

        * A Discuss channel only when the user belongs to it, or it is a channel
          open to their groups: an administrator's record rule reads every
          conversation, and a search is not where to find other people's.
        * A Knowledge article (Enterprise) only when the user has access to it
          as a member or through its internal permission, the rule Odoo gives
          every other user and applies to article comments even for an
          administrator, whose record rule reads every private article.
        * A private calendar event only for its attendees, or the events Odoo's
          "Private events" rule lets the user edit when the user may edit events: Odoo asks for
          write access, not read, to read the messages of a private event
          (``_mail_get_operation_for_mail_message_operation``).
        """
        if name == "discuss.channel":
            return [
                "|",
                ("is_member", "=", True),
                "&",
                ("channel_type", "=", "channel"),
                "|",
                ("group_public_id", "=", False),
                ("group_public_id", "in", self.env.user.all_group_ids.ids),
            ]
        if name == "knowledge.article":
            return [("user_has_access", "=", True)]
        if name == "calendar.event":
            partner = self.env.user.partner_id
            # sudo: a portal user reads events but not their attendees; which events
            # the user attends is about the user alone.
            attended = self.env["calendar.attendee"].sudo()._search([("partner_id", "in", partner.ids)])
            invited = [("attendee_ids", "any", attended)]
            # Odoo's "Private events" write rule (calendar_event_rule_private), without
            # its two effective_privacy terms: neither holds for a private event.
            if self.env[name].has_access("write"):
                uid = self.env.uid
                # sudo: Odoo evaluates the rule without the user's access to calendars.
                editable = (
                    self.env[name]
                    .sudo()
                    .with_context(active_test=False)
                    ._search(
                        Domain.OR(
                            [
                                [("user_id", "=", uid)],
                                [("create_uid", "=", uid)],
                                [("partner_ids", "in", partner.ids)],
                                [
                                    (
                                        "calendar_id.calendar_user_ids",
                                        "any",
                                        [("user_id", "=", uid), ("access_role", "=", "owner")],
                                    )
                                ],
                            ]
                        )
                    )
                )
                invited = Domain.OR([[("id", "in", editable)], invited])
            return Domain.OR([[("privacy", "!=", "private")], invited])
        return []

    @api.model
    def _scores(self, items, visible):
        """``{id: score}``: the share of the query's weight each record covers."""
        total = sum(item.weight for item in items) or 1.0
        return {candidate[0]: round(min(candidate[1] / total, 1.0), 4) for candidate in visible}

    @api.model
    def _search_items(self, config, records_model, terms, weights, allowed, live_entries, examined=(), fused=None):
        """``(items, frequencies, term_stats, population)``: each term with its operand and weight,
        its df, and what the answer reports about it.

        ``df`` counts only records **the user may see** (index rows inside
        ``allowed`` plus the records read live), capped at ``DF_CAP``, so rarity
        is calibrated to the user's scope. A word of 5+ letters with no visible
        match is searched by its prefix (``prefix_for``). Words that name the
        kind of record (``_type_terms``) weigh nothing. ``term_stats`` is
        ``{term: {df, type, prefix, prefix_df}}`` for Tuqui's confidence
        signal, from the same counts: no extra query. On Tuqui's side a term
        found only by its prefix counts as absent. With ``fused`` (the chatter
        merged in) ``df`` counts documents over both sides, inside the user's
        scope on both; it is ``DF_CAP`` for a word with ``CHATTER_MAX_ROWS``
        messages the user may see, and a word is retried by its prefix only
        when no visible document has it on either side. The words that weigh 0
        are counted on the fields only.
        """
        type_terms = self._type_terms(records_model._name, self.env.lang or "en_US")
        if fused:
            counted = lambda bases: self._fused_frequencies(fused, bases, type_terms)  # noqa: E731
        else:
            counted = lambda bases: self._plain_frequencies(  # noqa: E731
                config, bases, weights, allowed, live_entries, examined
            )
        frequencies = dict(zip(terms, counted([(term, None) for term in terms]), strict=True))
        # Every prefix in one count.
        retried = [(term, text.prefix_for(term)) for term in terms if not frequencies[term] and text.prefix_for(term)]
        prefixes, prefix_counts = {}, {}
        for (term, prefix), count in zip(retried, counted(retried), strict=True):
            if count:
                prefixes[term], prefix_counts[term] = prefix, count
        scoped = dict(frequencies)
        frequencies.update(prefix_counts)
        population = self._population(config)
        term_stats = {
            term: {
                "df": scoped[term],
                "type": term in type_terms,
                "prefix": prefixes.get(term),
                "prefix_df": prefix_counts.get(term),
            }
            for term in terms
        }
        items = [
            Item(
                term,
                self._arm_operand(term, prefixes.get(term), weights),
                prefixes.get(term),
                term_weight(frequencies[term], population, term in type_terms),
            )
            for term in terms
        ]
        return items, frequencies, term_stats, population

    @api.model
    def _plain_frequencies(self, config, bases, weights, allowed, live_entries, examined):
        """``df`` of each ``(term, prefix)`` over the index rows the user may see
        and the records read live, capped at ``DF_CAP``."""
        live_texts = ["\n\n".join(part for _weight, part in parts) for _res_id, parts in live_entries]
        operands = [self._arm_operand(term, prefix, weights) for term, prefix in bases]
        counts = self._scoped_frequencies(config, operands, allowed, examined)
        # The records read live already went through the permission check.
        return [
            min(
                count
                + sum(1 for body in live_texts if text.matched_terms(body, [term], {term: prefix} if prefix else None)),
                DF_CAP,
            )
            for (term, prefix), count in zip(bases, counts, strict=True)
        ]

    @api.model
    def _population(self, config):
        """Size of what is indexed, for the weight: what both sides divide by.

        The planner's estimate, or with a configured ``domain`` what the
        backfill counted; never a query of its own. It ignores the caller's
        scope and ``domain`` (those are in ``df``), so it counts no record for
        anybody.
        """
        if config._has_domain():
            return max(config.backfill_total, 1)
        self.env.cr.execute(
            SQL("SELECT GREATEST(reltuples, 0)::bigint FROM pg_class WHERE oid = %s::regclass", config._source_table())
        )
        return max(self.env.cr.fetchone()[0], config.backfill_total, 1)

    @api.model
    def _scoped_frequencies(self, config, operands, allowed, examined=()):
        """Index rows the user may see that match each operand, counted up to ``DF_CAP``.

        Rows of records read live (``examined``) are left out: they are out of
        date, and the caller counts those records from what it read."""
        if not operands:
            return []
        marker = text.quote_lexeme(config._marker())
        rows = self.env.execute_query(
            SQL(
                """
                SELECT o.n, (SELECT count(*) FROM (
                           SELECT 1 FROM search_relevant_document d
                            WHERE d.tsv @@ (%(marker)s::tsquery && o.operand::tsquery)
                              AND d.config_id = %(config)s
                              AND %(allowed)s
                              AND d.res_id <> ALL (%(examined)s::int[])
                            LIMIT %(cap)s) AS hits)
                  FROM unnest(%(operands)s::text[]) WITH ORDINALITY AS o(operand, n)
                 ORDER BY o.n
                """,
                marker=marker,
                config=config.id,
                allowed=_in_scope(allowed, SQL.identifier("d", "res_id"), SQL.identifier("d", "source_write_date")),
                cap=DF_CAP,
                examined=list(examined),
                operands=operands,
            )
        )
        return [count for _n, count in rows]

    @api.model
    @api.ormcache("model_name", "lang")
    def _type_terms(self, model_name, lang):
        """Terms of the words that name the kind of record, not its content.

        Derived, not listed: the model's description and the descriptions of the
        many2one fields of its search view (``project_id`` → "Project"), in the
        user's language and in English. Searching tasks, "tarea" and "proyecto"
        say what the person is looking for, not what the task says.
        """
        records_model = self.env[model_name].sudo()
        model_names = [model_name]
        try:
            arch = records_model.get_view(view_type="search")["arch"]
            for node in etree.fromstring(arch).iter("field"):
                field = records_model._fields.get(node.get("name") or "")
                if field and field.type == "many2one":
                    model_names.append(field.comodel_name)
        except (ValueError, etree.XMLSyntaxError):
            pass
        found = set()
        ir_model = self.env["ir.model"].sudo()
        for name in dict.fromkeys(model_names):
            record = ir_model._get(name)
            if not record:
                continue
            for language in {lang, "en_US"}:
                found.update(text.normalize_query(record.with_context(lang=language).name or "")[0])
        return frozenset(found)

    @api.model
    def _indexed_candidates(self, config, items, frequencies, weights, allowed, exclude, first_page, progress):
        """Ranked ``(res_id, score, rank)`` from the index, fetched lazily in pages.

        Candidates first come only from the terms rare in the user's scope
        (``_anchor_items``). That is exact while the page's last score exceeds
        what the left-out terms can add up to; when it does not, the page and
        the rest are computed again with every term. Weights are fixed before
        the first page, so every page belongs to the same order.
        """
        anchor = self._anchor_items(items, frequencies)
        left_out = sum(item.weight for item in items if item not in anchor)
        if anchor != items and min(item.weight for item in anchor) <= left_out:
            # No record found through an anchor could outscore what the common
            # terms alone add up to, so the shortcut would be recomputed anyway:
            # one query with every term instead of two.
            anchor = items
        offset, size = 0, first_page
        while offset < MAX_CANDIDATES:
            size = min(size, MAX_CANDIDATES - offset)
            page = self._rank_page(config, items, anchor, allowed, exclude, offset, size)
            if len(anchor) < len(items):
                if len(page) < size or page[-1][1] <= left_out + 1e-9:
                    anchor = items
                    page = self._rank_page(config, items, anchor, allowed, exclude, offset, size)
            yield from page
            if len(page) < size:
                return
            offset += size
            size = min(size * 2, MAX_WINDOW)
        progress["truncated"] = True

    @api.model
    def _anchor_items(self, items, frequencies):
        """The items rare enough to bring in candidates, or all of them.

        A term the user's scope holds in fewer than ``DF_CAP`` records is cheap
        to scan for; one past that is a word half the database says. When every
        term is common there is nothing to prune.
        """
        anchor = [item for item in items if frequencies[item.term] < DF_CAP]
        return anchor or items

    @api.model
    def _rank_page(self, config, items, anchor, allowed, exclude, offset, count):
        """``[(res_id, score, rank)]`` at positions ``[offset, offset + count)``.

        Only records ``allowed`` (the user's ``_search`` subquery) that carry at
        least one ``anchor`` term are candidates. ``ts_rank_cd`` is by far the
        expensive part and only breaks ties between records with the same score,
        so it is computed only for the records that score at least as much as
        the last one of the page — the same page, for a fraction of the work.
        """
        score = SQL(" + ").join(
            SQL("%s::float8 * (d.tsv @@ %s::tsquery)::int", item.weight, item.operand) for item in items
        )
        any_term = " | ".join(item.operand for item in items)
        any_anchor = " | ".join(item.operand for item in anchor)
        # execute_query, not cr.execute: the subquery carries fields to flush
        # (an ``active`` written earlier in this transaction must count).
        return self.env.execute_query(
            SQL(
                """
                WITH candidates AS MATERIALIZED (
                    SELECT d.id, %(score)s AS score
                      FROM search_relevant_document d
                     WHERE d.tsv @@ %(query)s::tsquery
                       AND d.config_id = %(config)s
                       AND %(allowed)s
                       AND d.res_id <> ALL (%(exclude)s::int[])
                ), tier AS (
                    SELECT COALESCE(
                        (SELECT score FROM candidates ORDER BY score DESC OFFSET %(last)s LIMIT 1), 0
                    ) AS floor
                )
                SELECT d.res_id, %(score)s AS score,
                       ts_rank_cd(%(rank_weights)s::float4[], d.tsv, %(any_term)s::tsquery, 33) AS rank
                  FROM search_relevant_document d
                 WHERE d.id = ANY (ARRAY(
                           SELECT c.id FROM candidates c WHERE c.score >= (SELECT floor FROM tier)
                       ))
                 ORDER BY score DESC, rank DESC, d.res_id DESC
                OFFSET %(offset)s LIMIT %(count)s
                """,
                score=score,
                query=f"{text.quote_lexeme(config._marker())} & ({any_anchor})",
                config=config.id,
                allowed=_in_scope(allowed, SQL.identifier("d", "res_id"), SQL.identifier("d", "source_write_date")),
                exclude=list(exclude),
                last=offset + count - 1,
                rank_weights=RANK_WEIGHTS,
                any_term=any_term,
                offset=offset,
                count=count,
            )
        )

    @api.model
    def _live_records(self, config, records_model, allowed, readable, confirm=False):
        """``(entries, examined, overflow)`` for records created after ``sync_cursor``.

        Records in ``allowed`` above the cursor whose index row is missing or
        older, read as the user. ``entries`` are ``(res_id, parts)``;
        ``examined`` their ids, whose index rows must not answer. The
        configuration's ``domain`` applies here too. Edits below the cursor are
        left to the next freshness pass. With ``confirm``, the ids go through
        the user's own ``search`` before the read, and ``entries`` is ``None``
        when it refuses one.
        """
        records_model.flush_model(["write_date"])
        # By id, not by write_date: there is no index on write_date, so that was
        # a scan of the whole table on every search. Ordered by id so the
        # primary key serves the LIMIT too when the cron is far behind.
        rows = self.env.execute_query(
            SQL(
                """
                SELECT t.id FROM %(table)s t
                 WHERE t.id > %(cursor)s
                   AND %(allowed)s
                   AND %(indexed)s
                   AND NOT EXISTS (
                       SELECT 1 FROM search_relevant_document d
                        WHERE d.config_id = %(config)s AND d.res_id = t.id
                          AND d.source_write_date = t.write_date AND d.layout = %(layout)s
                   )
                 ORDER BY t.id DESC
                 LIMIT %(limit)s
                """,
                table=SQL.identifier(records_model._table),
                cursor=config.sync_cursor,
                # The record is its own row here: always as new as itself.
                allowed=_in_scope(allowed, SQL.identifier("t", "id"), SQL.identifier("t", "write_date")),
                indexed=config._in_domain(SQL.identifier("t", "id")),
                config=config.id,
                layout=config.layout,
                limit=LIVE_MAX + 1,
            )
        )
        ids = [row[0] for row in rows]
        examined = ids[:LIVE_MAX]
        entries = []
        if confirm and examined and len(records_model.search([("id", "in", examined)])) < len(examined):
            return None, examined, len(ids) > LIVE_MAX
        if examined:
            for row in records_model.browse(examined).read([field.name for field in readable]):
                entries.append((row["id"], config._text_parts(row, readable)))
        return entries, examined, len(ids) > LIVE_MAX

    @api.model
    def _score_live(self, entries, items):
        """``[(res_id, score, rank)]`` for the live records that carry a term."""
        terms = [item.term for item in items]
        prefixes = {item.term: item.prefix for item in items if item.prefix}
        vectors = {}
        for res_id, parts in entries:
            if text.matched_terms("\n\n".join(part for _weight, part in parts), terms, prefixes):
                vectors[res_id] = text.build_tsvector(parts)
        if not vectors:
            return []
        # The live vectors only hold readable fields: no weight labels needed.
        plain = [self._plain_operand(item) for item in items]
        rows = self.env.execute_query(
            SQL(
                """
                SELECT v.res_id, %(score)s, ts_rank_cd(%(rank_weights)s::float4[], v.tsv, %(any_term)s::tsquery, 33)
                  FROM unnest(%(ids)s::int[], %(vectors)s::tsvector[]) AS v(res_id, tsv)
                """,
                score=SQL(" + ").join(
                    SQL("%s::float8 * (v.tsv @@ %s::tsquery)::int", item.weight, operand)
                    for item, operand in zip(items, plain, strict=True)
                ),
                rank_weights=RANK_WEIGHTS,
                any_term=" | ".join(plain),
                ids=list(vectors),
                vectors=list(vectors.values()),
            )
        )
        return sorted(rows, key=_sort_key)

    @staticmethod
    def _plain_operand(item):
        operand = text.quote_lexeme(item.prefix) + ":*" if item.prefix else text.quote_lexeme(item.term)
        return operand

    @api.model
    def _resolve_codes(self, config, terms, fallbacks, weights, allowed, live_entries, examined, fused=None):
        """Replace each whole code no visible record has by its parts with digits.

        The searched terms go out in the answer, so the check looks only at
        records the user may read; otherwise it would tell whether the code
        exists somewhere.
        """
        resolved = []
        suffix = f":{weights}" if weights else ""
        if fused:
            # Every code in one count.
            codes = [term for term in terms if fallbacks.get(term)]
            visible = dict(zip(codes, self._fused_frequencies(fused, [(code, None) for code in codes]), strict=True))
        for term in terms:
            parts = fallbacks.get(term)
            if not parts:
                resolved.append(term)
                continue
            if fused:
                found = visible[term] > 0
            else:
                found = any(
                    term in text.matched_terms("\n\n".join(part for _weight, part in entry_parts), [term])
                    for _res_id, entry_parts in live_entries
                ) or self._operand_is_visible(config, text.quote_lexeme(term) + suffix, allowed, examined)
            resolved.extend([term] if found else parts)
        return list(dict.fromkeys(resolved))

    @api.model
    def _operand_is_visible(self, config, operand, allowed, examined):
        """Whether a record the user may read (``allowed``) matches ``operand``, from the index."""
        return bool(
            self.env.execute_query(
                SQL(
                    """
                    SELECT 1 FROM search_relevant_document d
                     WHERE d.tsv @@ %s::tsquery AND d.config_id = %s
                       AND %s AND d.res_id <> ALL (%s::int[])
                     LIMIT 1
                    """,
                    f"{text.quote_lexeme(config._marker())} & ({operand})",
                    config.id,
                    _in_scope(allowed, SQL.identifier("d", "res_id"), SQL.identifier("d", "source_write_date")),
                    list(examined),
                )
            )
        )

    @staticmethod
    def _merge(indexed, live):
        """Both candidate streams in one order, pulling the index lazily."""
        live = deque(live)
        if not live:
            yield from indexed
            return
        for candidate in indexed:
            while live and _sort_key(live[0]) < _sort_key(candidate):
                yield live.popleft()
            yield candidate
        yield from live

    @api.model
    def _filter_visible(self, records_model, candidates, domain, limit, window):
        """The candidates the current user can see, in rank order, until ``limit``.

        Second permission guard, for what a model filters in Python. Returns the
        whole last window, not only ``limit``: the caller takes the head.
        """
        visible = []
        while len(visible) < limit:
            chunk = list(islice(candidates, window))
            if not chunk:
                break
            allowed = set(records_model.search(Domain("id", "in", [c[0] for c in chunk]) & domain).ids)
            visible.extend(candidate for candidate in chunk if candidate[0] in allowed)
            window = min(window * 2, MAX_WINDOW)
        return visible

    # ─── What the user reads ─────────────────────────────────────────────

    @api.model
    def _parent_values(self, config, records):
        """``{id: {"res_model", "res_id"}}`` of the record each one hangs from.

        Only for a model that points at another (``_parent_fields``), like a
        chatter message and its task. Read as the user over records that passed
        the permission check, never from the index: it says where a record
        hangs, never that the user may read the parent.
        """
        pair = config._parent_fields()
        if not pair or not records:
            return {}
        model_field, id_field = pair
        if not all(records._has_field_access(records._fields[name], "read") for name in pair):
            return {}
        return {
            row["id"]: {"res_model": row[model_field] or None, "res_id": row[id_field] or None}
            for row in records.read([model_field, id_field])
        }

    @api.model
    def _describe(self, config, records, items, readable, examined):
        """``{id: (matched_terms, snippet)}`` from the user's own read.

        Only the fields that can hold a match are read: the record name, plus
        the fields whose weight label the index says matched (all readable
        fields for records read live). Each raw value is cut at
        ``DESCRIBE_MAX_CHARS`` before its HTML is converted.
        """
        if not records:
            return {}
        terms = [item.term for item in items]
        prefixes = {item.term: item.prefix for item in items if item.prefix}
        weight_map = config._weight_map()
        name_field = records._rec_name
        by_label = {weight_map[field.name]: field for field in readable}
        to_read = {res_id: {field.name for field in readable} for res_id in records.ids if res_id in set(examined)}
        indexed_ids = [res_id for res_id in records.ids if res_id not in to_read]
        if indexed_ids and by_label:
            any_plain = " | ".join(self._plain_operand(item) for item in items)
            rows = self.env.execute_query(
                SQL(
                    "SELECT d.res_id, %s FROM search_relevant_document d WHERE d.config_id = %s AND d.res_id = ANY(%s)",
                    SQL(", ").join(
                        SQL('ts_filter(d.tsv, %s::"char"[]) @@ %s::tsquery', "{%s}" % label.lower(), any_plain)
                        for label in by_label
                    ),
                    config.id,
                    indexed_ids,
                )
            )
            labels = list(by_label)
            for res_id, *hits in rows:
                to_read[res_id] = {by_label[label].name for label, hit in zip(labels, hits, strict=True) if hit}
        readable_names = {field.name for field in readable}
        groups = {}
        for res_id in records.ids:
            names = set(to_read.get(res_id) or readable_names)
            if name_field in readable_names:
                names.add(name_field)
            groups.setdefault(frozenset(names), []).append(res_id)
        described = {}
        for names, ids in groups.items():
            fields_ = [field for field in readable if field.name in names]
            for row in records.browse(ids).read([field.name for field in fields_]):
                row = {
                    key: value[:DESCRIBE_MAX_CHARS] if isinstance(value, str) else value for key, value in row.items()
                }
                body = "\n\n".join(part for _weight, part in config._text_parts(row, fields_))
                described[row["id"]] = (
                    text.matched_terms(body, terms, prefixes),
                    text.snippet(body, terms, prefixes),
                )
        return described
