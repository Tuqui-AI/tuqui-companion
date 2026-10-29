"""Relevance search over enabled models.

Everything runs on ``res.partner`` so the suite depends on ``base`` only; the
``project.task`` case is skipped when ``project`` is not installed.

What is pinned here (regressions found in review, reduced to base models):

* a model nobody enabled answers ``not_enabled``, not an error;
* enabling a model does not index it in the request; the cron fills the index
  in batches, reports progress and switches itself off;
* **no internal cap can starve a narrow domain or a user who sees little**: the
  domain and the record rules are inside the ranking query, except for a
  model whose ``_search`` filters in Python, which is ranked as the superuser
  and checked over the candidates — and still never returns what the user
  cannot see;
* **the rare-terms shortcut never changes the answer**;
* **a word in a field the user cannot read does not match**;
* **freshness is honest**: a record created after the cursor is matched at
  search time, an edit is picked up by the next pass, and a cron that stopped
  makes the answer ``partial``; permissions never wait for the cron;
* codes with hyphens, dots and slashes split like on Tuqui's side, and the
  normalization rule is the same one;
* **a model that only grows** (``append_only``) is kept fresh by id, its
  backfill walks bounded windows of ids and ends when the domain is covered,
  and its answer carries the record each row hangs from;
* nothing is installed in the database besides the table;
* records the user cannot see never come back, neither as ids nor in fragments;
  archived records neither; a model's index never answers for another one;
* **and no count of them comes back either**: for a model ranked as the
  superuser, ``term_stats``, ``population`` and the code resolution of
  ``terms`` are counted over the candidates that passed the permission check,
  so a domain aimed at a record the user cannot read tells it nothing;
* ``snippet`` and ``matched_terms`` come from the user's own read, never from
  the index;
* **a document search with its chatter** scores the fields plus one message,
  and a message the user cannot read — for any reason — moves nothing in the
  answer; a ``via`` the user's own ``mail.message.search`` refuses is left out.
"""

import math
from datetime import datetime, timedelta
from unittest.mock import patch

import psycopg2
from odoo import Command, fields
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.modules.db import has_unaccent
from odoo.tests import BaseCase, TransactionCase, tagged
from odoo.tools import SQL, mute_logger

from ..models import (
    search_relevant as search_module,
    search_relevant_config as config_module,
    search_relevant_text as text,
)
from ..models.search_relevant_config import SearchRelevantConfig

_RULE_SAMPLES = [
    "Motor, TRIFÁSICO; (Siemens)! de la estado",
    "PR-979 SO-1234 FURN_7800 inv/2024/0001 v2.0 10A ana.perez@acme.com wiki.zorzalhost.inc",
    "la tarea donde charlamos de conciliación bancaria con Ñandú",
    "x" * 70 + " ok " + "tambien también",
]


def _rule_behaviour():
    """A digest of what the rule does to a fixed set of texts."""
    import hashlib

    digest = hashlib.sha256()
    for sample in _RULE_SAMPLES:
        digest.update(repr(text.normalize_query(sample)).encode())
        digest.update(repr(text.build_tsvector([("A", sample), ("B", sample)])).encode())
    return digest.hexdigest()[:16]


PINNED_RULE = ("c95c331bf112cba9", "ddb86630581b569e")


@tagged("post_install", "-at_install", "base_search_relevant")
class TestSearchRelevantText(BaseCase):
    """This module's normalization rule. Compatible with Tuqui's (same shape of
    ``terms``), not a copy of it: the cases started from Tuqui's tests."""

    def test_normalization_rule(self):
        cases = [
            ("Motor, TRIFÁSICO; (Siemens)!", ["motor", "trifasico", "siemens"], []),
            (
                "la tarea donde charlamos de conciliación bancaria",
                ["tarea", "conciliacion", "bancaria"],
                ["la", "donde", "charlamos", "de"],
            ),
            ("tambien también ticket", ["ticket"], ["tambien"]),
            ("OT 10 v2 ab 10A", ["10", "v2", "10a"], ["ot", "ab"]),
            # Codes with digits are one term; emails too; the rest splits.
            ("PR-979", ["pr-979"], []),
            ("pedido SO-1234", ["pedido", "so-1234"], []),
            ("versión v2.0 del 10/2025", ["version", "v2.0", "10/2025"], ["del"]),
            ("FURN_7800", ["furn_7800"], []),
            ("ana.perez@acme.com", ["ana.perez@acme.com"], []),
            ("motor/bomba wiki.zorzalhost.inc", ["motor", "bomba", "wiki", "zorzalhost", "inc"], []),
            ("siemens Siemens SIEMENS camión camion", ["siemens", "camion"], []),
            ("lo de la que", [], ["lo", "de", "la", "que"]),
            ("Revisar PR 979 estado", ["revisar", "979", "estado"], ["pr"]),
        ]
        for query, terms, ignored in cases:
            got_terms, got_ignored, _fallbacks = text.normalize_query(query)
            self.assertEqual(got_terms, terms, query)
            self.assertEqual(set(got_ignored), set(ignored), query)
        # The parts with digits are what a code falls back to.
        self.assertEqual(
            text.normalize_query("PR-979 inv/2024/0001")[2], {"pr-979": ["979"], "inv/2024/0001": ["2024", "0001"]}
        )
        self.assertEqual(text.normalize_query("ana.perez@acme.com")[2], {})

    def test_the_cap_keeps_codes_and_long_words_whatever_the_order(self):
        words = [
            "uno1",
            "motores",
            "trifasicos",
            "proveedor",
            "siemens",
            "pepito",
            "bobinado",
            "carcasa",
            "eje",
            "rotor",
            "tornillo",
            "arandela",
            "junta",
            "cable",
            "fusible",
        ]
        self.assertGreater(len(words), text.MAX_TERMS)
        kept = {frozenset(text.normalize_query(" ".join(words[i:] + words[:i]))[0]) for i in range(len(words))}
        self.assertEqual(len(kept), 1)
        (terms,) = kept
        self.assertEqual(len(terms), text.MAX_TERMS)
        self.assertIn("uno1", terms)
        self.assertNotIn("eje", terms)

    def test_index_entries_hold_the_query_terms_with_their_field_and_position(self):
        vector = text.build_tsvector([("A", "PR-979 de Siemens"), ("B", "motor de siemens")], extra_lexemes=["x:y"])
        self.assertEqual(vector, "'979':2A 'pr-979':1A 'siemens':4A,15B 'motor':13B 'x:y'")
        self.assertIsNone(text.build_tsvector([("A", "de la y o"), ("B", "")]))

    def test_the_rule_version_follows_the_rule(self):
        """N3: an index built by another rule must be re-indexed, so the version
        cannot depend on someone remembering to bump it.

        Word lists, patterns and limits are inside the fingerprint. What the
        code does with them is pinned here by its output: if this fails because
        the output changed, bump ``RULE_REVISION``; then update both values."""
        self.assertEqual((text.NORMALIZATION_VERSION, _rule_behaviour()), PINNED_RULE)

    def test_changing_the_word_list_changes_the_version(self):
        with patch.object(text, "STOPWORDS", text.STOPWORDS | {"estado"}):
            self.assertNotEqual(text._rule_fingerprint(), text.NORMALIZATION_VERSION)
        with patch.object(text, "MAX_LEXEME_CHARS", 32):
            self.assertNotEqual(text._rule_fingerprint(), text.NORMALIZATION_VERSION)


@tagged("post_install", "-at_install", "base_search_relevant")
class TestSearchRelevant(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Results are asserted on the records these tests create. A database with
        # hundreds of modules has demo partners that legitimately contain a word a
        # test searches ("Odoo Inc" for "odoo", on runbot): they may rank in, and
        # that is correct. Ids only grow, so "created here" is "above this line".
        cls.baseline = {}
        for model in ("res.partner", "res.partner.category", "project.task"):
            if model in cls.env:
                cls.env.cr.execute(SQL("SELECT COALESCE(MAX(id), 0) FROM %s", SQL.identifier(cls.env[model]._table)))
                cls.baseline[model] = cls.env.cr.fetchone()[0]
        cls.Config = cls.env["search.relevant.config"]
        cls.main_company = cls.env.company
        cls.other_company = cls.env["res.company"].create({"name": "Relevance Search Other Co"})
        cls.restricted_group = cls.env["res.groups"].create({"name": "Relevance search restricted"})
        cls.user = cls.env["res.users"].create(
            {
                "name": "Relevance Search User",
                "login": "search_relevant_user",
                "company_id": cls.main_company.id,
                "company_ids": [(6, 0, [cls.main_company.id])],
                "group_ids": [(6, 0, [cls.env.ref("base.group_user").id, cls.restricted_group.id])],
            }
        )
        # A record rule only this user's group carries: partners flagged with
        # this ref are invisible to them.
        cls.env["ir.rule"].create(
            {
                "name": "Relevance search: hide flagged partners",
                "model_id": cls.env.ref("base.model_res_partner").id,
                "groups": [(6, 0, [cls.restricted_group.id])],
                "domain_force": "[('ref', '!=', 'search-hidden')]",
            }
        )
        Partner = cls.env["res.partner"]
        cls.both_terms = Partner.create(
            {
                "name": "Bomba industrial",
                "comment": "<p>El motor trifásico de <b>Siemens</b> quedó instalado en planta.</p>",
            }
        )
        cls.one_term = Partner.create(
            {
                "name": "Motor genérico",
                "comment": "<p>motor motor motor, repuesto de motor para el motor viejo</p>",
            }
        )
        cls.other_company_partner = Partner.create(
            {
                "name": "Proveedor externo",
                "company_id": cls.other_company.id,
                "comment": "<p>Contrato confidencial del motor Siemens de la otra compañía</p>",
            }
        )
        cls.hidden_partner = Partner.create(
            {
                "name": "Cliente reservado",
                "ref": "search-hidden",
                "comment": "<p>Oferta secreta por el motor Siemens del cliente reservado</p>",
            }
        )

    # ─── Helpers ──────────────────────────────────────────────────────────

    # ─── Helpers ──────────────────────────────────────────────────────────

    def _enable(self, model="res.partner", field_names=("name", "comment")):
        fields_ = self.env["ir.model.fields"].search([("model", "=", model), ("name", "in", list(field_names))])
        existing = self.Config.with_context(active_test=False).search([("model", "=", model)])
        if existing:  # a database where an administrator already enabled it
            existing.write({"field_ids": [(6, 0, fields_.ids)], "active": True})
            return existing
        return self.Config.create({"model_id": self.env["ir.model"]._get_id(model), "field_ids": [(6, 0, fields_.ids)]})

    def _index(self, config):
        while config.backfill_cursor:
            config._backfill_batch(1000)
        config._sync_batch(1000)

    def _search(self, query, user=None, model="res.partner", **kwargs):
        env = self.env(user=user or self.user)
        # Room for the records created here even if demo data of a big database
        # also matches; the default limit is tested on its own.
        kwargs.setdefault("limit", 50)
        response = env["search.relevant"].search_relevant(model, query, **kwargs)
        response["_model"] = model
        return response

    def _later_write_date(self, record, seconds=5):
        """Give ``record`` the write_date a later transaction would give it.

        Inside a test everything happens in one transaction, so a write keeps
        the same ``now()`` the indexing saw and looks unchanged. In production
        the next write always comes from a newer transaction.
        """
        record.flush_recordset()
        self.env.cr.execute(
            SQL(
                "UPDATE %s SET write_date = %s WHERE id = %s",
                SQL.identifier(record._table),
                self.env.cr.now() + timedelta(seconds=seconds),
                record.id,
            )
        )

    def _indexed_ids(self, config):
        self.env.cr.execute("SELECT res_id FROM search_relevant_document WHERE config_id = %s", [config.id])
        return {row[0] for row in self.env.cr.fetchall()}

    def _catch_up(self, config):
        """Two passes ``SYNC_ID_MARGIN`` apart, as the cron does them: the cursor
        reaches the newest id, so nothing is matched live and only the index answers."""
        for _pass in range(2):
            config.sync_reached_at = self.env.cr.now() - config_module.SYNC_ID_MARGIN - timedelta(minutes=1)
            config._sync_batch(1000)
        self.assertEqual(config.sync_cursor, config._max_id())

    def _mine(self, response):
        """The records of ``response`` created by these tests, in rank order."""
        baseline = self.baseline.get(response.get("_model", "res.partner"), 0)
        return [record for record in response["records"] if record["id"] > baseline]

    def _ids(self, response):
        return [record["id"] for record in self._mine(response)]

    def _cannot_read(self, user, model, field_name):
        """Patch ``_has_field_access`` so ``user`` cannot read ``model.field_name``
        — how ``project.task`` hides fields from portal users."""
        model_class = type(self.env[model])
        original = model_class._has_field_access

        def restricted(records, field, operation):
            if records.env.uid == user.id and field.name == field_name:
                return False
            return original(records, field, operation)

        return patch.object(model_class, "_has_field_access", restricted)

    # ─── Enablement & coverage ───────────────────────────────────────────

    def test_model_not_enabled_is_a_state_not_an_error(self):
        response = self._search("motor siemens")
        self.assertEqual(response["engine"], "companion_fts")
        self.assertEqual(
            response["coverage"], {"state": "not_enabled", "indexed_until": None, "fields": [], "chatter": "off"}
        )
        self.assertEqual(self._mine(response), [])
        self.assertEqual(response["terms"], ["motor", "siemens"])
        response = self._search("motor", model="no.such.model")
        self.assertEqual(response["coverage"]["state"], "not_enabled")

    def test_enabling_indexes_nothing_until_the_cron_runs(self):
        config = self._enable()
        self.assertTrue(config.backfill_cursor, "enabling must leave the work to the cron")
        self.assertEqual(config.document_count, 0)
        response = self._search("motor siemens")
        self.assertEqual(response["coverage"]["state"], "partial")
        self.assertTrue(response["coverage"]["indexed_from"])
        self.assertEqual(response["coverage"]["fields"], ["name", "comment"])

        self._index(config)
        response = self._search("motor siemens")
        self.assertEqual(response["coverage"]["state"], "complete")
        self.assertEqual(response["coverage"]["indexed_until"], config.sync_watermark.strftime("%Y-%m-%dT%H:%M:%SZ"))
        self.assertNotIn("indexed_from", response["coverage"])
        self.assertIn(self.both_terms.id, self._ids(response))

    def test_backfill_goes_from_newest_to_oldest_in_batches(self):
        config = self._enable()
        self.assertFalse(config.backfill_total, "counting the table is the cron's first step, not the click")

        self.assertEqual(config._backfill_batch(2), 2)
        total = config.backfill_total
        self.assertGreater(total, 4)
        self.assertEqual(config.backfill_done, 2)
        self.assertEqual(config.state, "indexing")
        indexed = self._indexed_ids(config)
        self.assertIn(self.hidden_partner.id, indexed)
        self.assertIn(self.other_company_partner.id, indexed)
        self.assertNotIn(self.both_terms.id, indexed)

        while config.backfill_cursor:
            config._backfill_batch(2)
        self.assertEqual(config.state, "ready")
        self.assertEqual(config.backfill_done, total)
        # Partners without any searchable text get no row.
        self.assertLessEqual(config.document_count, total)
        self.assertIn(self.both_terms.id, self._indexed_ids(config))

    def test_cron_reports_progress_by_batches_and_switches_itself_off(self):
        config = self._enable()
        cron = self.env.ref("base_search_relevant.ir_cron_search_relevant_index")
        self.assertTrue(cron.active, "enabling a model must wake the cron")
        self.env["ir.config_parameter"].sudo().set_param("base_search_relevant.batch_size", "3")

        def run_job():
            self.env.flush_all()
            with self.enter_registry_test_mode(), self.registry.cursor() as cr:
                self.registry["ir.cron"]._process_job(
                    cr, {**cron.read(load=None)[0], "done": 0, "remaining": 0, "timed_out_counter": 0}
                )
            self.env.invalidate_all()

        original = SearchRelevantConfig._backfill_batch
        flush = SearchRelevantConfig._flush_pending_index
        with (
            patch.object(SearchRelevantConfig, "_backfill_batch", autospec=True, side_effect=original) as batches,
            patch.object(SearchRelevantConfig, "_flush_pending_index", autospec=True, side_effect=flush) as flushes,
        ):
            run_job()
        # S9: the GIN pending list is flushed at the end of each run.
        self.assertTrue(flushes.called)
        total = config.backfill_total
        self.assertGreater(total, 4)
        self.assertGreaterEqual(batches.call_count, total // 3, "the backfill must run in batches")
        self.assertEqual(config.state, "ready")
        progress = self.env["ir.cron.progress"].sudo().search([("cron_id", "=", cron.id)])
        self.assertGreaterEqual(sum(progress.mapped("done")), total, "progress must count the indexed records")
        self.assertEqual(progress.sorted("id")[-1:].remaining, 0)
        self.assertTrue(cron.active, "while a model is enabled the cron keeps the index fresh")

        self.Config.search([]).active = False
        run_job()
        self.assertFalse(cron.active, "with no model enabled the cron switches itself off")

    def test_archiving_disables_search_and_drops_the_index(self):
        config = self._enable()
        self._index(config)
        rows = config.document_count
        self.assertTrue(rows)
        config.active = False
        self.assertEqual(self._search("motor")["coverage"]["state"], "not_enabled", "search stops at once")
        self.assertTrue(config.cleanup_pending)
        self.assertEqual(config._cleanup_batch(rows - 1), (rows - 1, True), "rows are deleted by the cron, in batches")
        self.assertEqual(config._cleanup_batch(rows), (1, False))
        self.assertFalse(config.cleanup_pending)
        config.invalidate_recordset(["document_count"])
        self.assertEqual(config.document_count, 0)

    # ─── Freshness ────────────────────────────────────────────────────────

    def test_a_record_created_after_the_last_pass_is_found_before_the_cron(self):
        """Regression: "fresh record, before cron: {'state': 'complete', ...} []"."""
        config = self._enable()
        self._index(config)
        self._catch_up(config)
        self.assertFalse(config.append_only, "precondition: a model whose pass goes by write_date")
        fresh = self.env["res.partner"].create({"name": "Recién creado ornitorrinco"})
        self.assertNotIn(fresh.id, self._indexed_ids(config))
        response = self._search("ornitorrinco")
        self.assertEqual(self._ids(response), [fresh.id])
        self.assertEqual(response["coverage"]["state"], "complete")
        self.assertEqual(self._mine(response)[0]["matched_terms"], ["ornitorrinco"])

    def test_an_edit_is_matched_on_its_new_text_after_the_next_pass(self):
        """Searches do not look for edits: the next pass of the cron does. Until
        then the old text matches, and what the answer shows is read from the
        record as it is now."""
        config = self._enable()
        self._index(config)
        self.assertIn(self.one_term.id, self._ids(self._search("genérico")))

        self.one_term.name = "Compresor rotativo"
        self._later_write_date(self.one_term)
        self.assertEqual(self._mine(self._search("compresor rotativo")), [], "the new text waits for the pass")
        response = self._search("genérico")
        self.assertIn(self.one_term.id, self._ids(response), "the old text still matches")
        record = next(r for r in response["records"] if r["id"] == self.one_term.id)
        self.assertEqual(record["matched_terms"], [])
        self.assertNotIn("genérico", record["snippet"].lower())
        self.assertEqual(response["coverage"]["state"], "complete")

        processed, more, _last = config._sync_batch(100)
        self.assertEqual((processed, more), (1, False), "only the written record is re-indexed")
        self.assertIn(self.one_term.id, self._ids(self._search("compresor rotativo")))
        self.assertNotIn(self.one_term.id, self._ids(self._search("genérico")))

    def test_a_new_record_edited_after_a_pass_answers_once_by_its_new_text(self):
        """A record above the cursor is read live even after a pass indexed it.
        Its index row is out of date then, and must not answer for it: the old
        text does not find it, and the new one finds it once."""
        config = self._enable()
        self._index(config)
        record = self.env["res.partner"].create({"name": "Zqnuevox inicial"})
        config._sync_batch(100)
        self.assertIn(record.id, self._indexed_ids(config), "the pass indexed it")
        self.assertGreater(record.id, config.sync_cursor, "still above the cursor, inside the margin")

        record.name = "Zqnuevox cambiado"
        self._later_write_date(record)
        self.assertNotIn(record.id, self._ids(self._search("inicial")))
        self.assertEqual(self._ids(self._search("cambiado")).count(record.id), 1)
        self.assertEqual(self._ids(self._search("zqnuevox")).count(record.id), 1)

    def test_a_cron_that_stopped_makes_the_answer_partial(self):
        config = self._enable()
        self._index(config)
        self.assertEqual(self._search("motor")["coverage"]["state"], "complete")
        config.sync_watermark = self.env.cr.now() - timedelta(hours=2)
        self.assertEqual(self._search("motor")["coverage"]["state"], "partial")

    def test_too_many_unindexed_writes_make_the_answer_partial(self):
        config = self._enable()
        self._index(config)
        self.env["res.partner"].create([{"name": f"Pendiente kiwi {n}"} for n in range(3)])
        with patch.object(search_module, "LIVE_MAX", 2):
            response = self._search("kiwi", limit=50)
        self.assertEqual(response["coverage"]["state"], "partial")
        self.assertEqual(len(self._mine(response)), 2)

    def test_a_deleted_record_is_never_returned_and_is_purged(self):
        config = self._enable()
        self._index(config)
        gone = self.env["res.partner"].create({"name": "Registro efímero zanahoria"})
        config._sync_batch(100)
        self.assertEqual(self._ids(self._search("zanahoria")), [gone.id])

        gone.unlink()
        self.assertEqual(self._mine(self._search("zanahoria")), [], "the user's own search drops deleted ids")
        self.assertEqual(config._purge_deleted(), 1)
        self.assertNotIn(gone.id, self._indexed_ids(config))

    def test_a_record_that_fails_to_index_does_not_stop_the_batch(self):
        config = self._enable()
        original = SearchRelevantConfig._insert_entries
        broken = self.one_term.id

        def insert(records, entries):
            if any(entry[0] == broken for entry in entries):
                raise psycopg2.errors.ProgramLimitExceeded("simulated")
            return original(records, entries)

        with (
            patch.object(SearchRelevantConfig, "_insert_entries", insert),
            mute_logger("odoo.addons.base_search_relevant.models.search_relevant_config"),
        ):
            self._index(config)
        indexed = self._indexed_ids(config)
        self.assertNotIn(broken, indexed)
        self.assertIn(self.both_terms.id, indexed)
        self.assertFalse(config.backfill_cursor)

    # ─── Permissions ─────────────────────────────────────────────────────

    def test_a_record_that_stops_being_visible_is_gone_before_the_cron(self):
        """Permissions never depend on how fresh the index is: the ranking runs
        inside the user's ``_search`` over current data."""
        config = self._enable()
        self._index(config)
        self._catch_up(config)
        self.assertIn(self.both_terms.id, self._ids(self._search("bomba trifásico")))

        # What makes it visible changes; the cron does not run.
        self.both_terms.ref = "search-hidden"
        self.one_term.company_id = self.other_company
        self.assertTrue({self.both_terms.id, self.one_term.id} <= self._indexed_ids(config), "still in the index")
        for query in ("bomba trifásico", "motor genérico"):
            response = self._search(query)
            self.assertFalse({self.both_terms.id, self.one_term.id} & set(self._ids(response)), query)
        self.assertEqual(self._search("trifásico")["term_stats"]["trifasico"]["df"], 0)

    def test_records_the_user_cannot_see_never_come_back(self):
        config = self._enable()
        self._index(config)
        forbidden = {self.other_company_partner.id, self.hidden_partner.id}

        # They are in the index and rank for this query...
        items = [search_module.Item(term, f"'{term}'", None, 1.0) for term in ("motor", "siemens")]
        everything = self.env["res.partner"].sudo()._search([]).subselect()
        ranked = {
            row[0] for row in self.env["search.relevant"]._rank_page(config, items, items, everything, [], 0, 1000)
        }
        self.assertTrue(forbidden <= ranked, "precondition: the forbidden records match the query")

        # ...but the user gets neither their ids nor their text.
        response = self._search("motor siemens", limit=50)
        self.assertFalse(forbidden & set(self._ids(response)))
        self.assertIn(self.both_terms.id, self._ids(response))
        fragments = " ".join(record["snippet"] for record in self._mine(response)).lower()
        for secret in ("confidencial", "secreta", "reservado", "otra compañía"):
            self.assertNotIn(secret, fragments)

        # An administrator of both companies sees the other company's record.
        admin = self.env.ref("base.user_admin")
        admin.company_ids = [(4, self.other_company.id)]
        admin_env = self.env(user=admin, context={"allowed_company_ids": [self.main_company.id, self.other_company.id]})
        self.assertIn(
            self.other_company_partner.id,
            self._ids(admin_env["search.relevant"].search_relevant("res.partner", "motor siemens", limit=50)),
        )

    def test_a_narrow_domain_is_not_starved_by_the_candidate_cap(self):
        """Regression: 1.200 "Factura N" in project A, one in project C →
        ``domain=[('project_id','=',C)]`` came back empty and complete."""
        config = self._enable()
        self.env["res.partner"].create([{"name": f"Facturex {n}", "ref": "lote-a"} for n in range(20)])
        target = self.env["res.partner"].create(
            {"name": "Consulta cliente", "ref": "lote-c", "comment": "<p>facturex electrónica rechazada</p>"}
        )
        self._index(config)
        with patch.object(search_module, "MAX_CANDIDATES", 5), patch.object(search_module, "MAX_WINDOW", 5):
            response = self._search("facturex", domain=[("ref", "=", "lote-c")])
        self.assertEqual(self._ids(response), [target.id])
        self.assertEqual(response["coverage"]["state"], "complete")

    def test_a_user_who_sees_little_is_not_starved_by_the_candidate_cap(self):
        """Regression: a portal user who sees one task — 'zanahoria' → [7],
        'zanahoria factura' → []."""
        config = self._enable()
        self.env["res.partner"].create(
            [{"name": f"Zqfacturex zqciruelax {n}", "company_id": self.other_company.id} for n in range(20)]
        )
        # Made-up words, and without a real word's first letters: a word the user
        # sees nowhere is retried by prefix ("facturex" → "factu" would find facturas).
        visible = self.env["res.partner"].create({"name": "Zqzanahorix del portal"})
        self._index(config)
        with patch.object(search_module, "MAX_CANDIDATES", 5), patch.object(search_module, "MAX_WINDOW", 5):
            for query in ("zqzanahorix", "zqzanahorix zqfacturex", "zqfacturex zqciruelax zqzanahorix"):
                response = self._search(query, limit=50)
                self.assertEqual([record["id"] for record in response["records"]], [visible.id], query)

    def test_when_the_final_check_removes_candidates_it_asks_for_more(self):
        """The second guard (``search`` on the ids), for models that filter in
        Python: simulated with a ``_search`` that does not see the record rule."""
        config = self._enable()
        self.env["res.partner"].create(
            [{"name": f"Zinquex pernito cromax {n}", "company_id": self.other_company.id} for n in range(5)]
        )
        visible = self.env["res.partner"].create({"name": "Zinquex común"})
        self._index(config)
        search_class = type(self.env["search.relevant"])

        def blind(search, _config, records_model, domain):
            return records_model.sudo()._search(domain).subselect()

        with (
            patch.object(search_class, "_allowed_subquery", blind),
            patch.object(search_module, "MIN_WINDOW", 1),
            patch.object(search_module, "WINDOW_FACTOR", 1),
            patch.object(search_module, "MAX_WINDOW", 2),
        ):
            response = self._search("zinquex pernito cromax", limit=1)
        # Made-up words: the whole answer is asserted, not only the records created here.
        self.assertEqual([record["id"] for record in response["records"]], [visible.id])
        self.assertEqual(response["records"][0]["matched_terms"], ["zinquex"])

    def test_the_answer_of_a_model_ranked_normally_is_not_touched(self):
        """A model that composes its permissions into SQL keeps counting ``df``
        over everything the user may see — not over the candidates examined —
        and ``population`` stays the size of what is indexed."""
        config = self._enable()
        self.env["res.partner"].create([{"name": f"Zqmanzanox {n}"} for n in range(12)])
        self._index(config)
        self._catch_up(config)
        response = self._search("zqmanzanox", limit=3)
        self.assertEqual(len(response["records"]), 3)
        self.assertEqual(response["term_stats"]["zqmanzanox"]["df"], 12)
        self.assertEqual(response["population"], self.env["search.relevant"]._population(config))

    def _chatter(self):
        """Comments on tasks, each hidden from someone for a different reason.

        ``member`` is an internal project user; ``portal`` follows one task of a
        project open to portal users. What each may read is what Odoo's own
        ``mail.message.search`` returns them, and the search must stay inside it.
        """
        if "project.task" not in self.env:
            self.skipTest("project is not installed")
        Users = self.env["res.users"].with_context(no_reset_password=True)
        member = Users.create(
            {
                "name": "Relevance Search Member",
                "login": "search_relevant_member",
                "group_ids": [(6, 0, [self.env.ref("project.group_project_user").id])],
            }
        )
        portal = Users.create(
            {
                "name": "Relevance Search Portal Chatter",
                "login": "search_relevant_portal_chatter",
                "group_ids": [(6, 0, [self.env.ref("base.group_portal").id])],
            }
        )
        Project = self.env["project.project"]
        Task = self.env["project.task"]
        open_project = Project.create({"name": "Zq abierto", "privacy_visibility": "employees"})
        private_project = Project.create({"name": "Zq privado", "privacy_visibility": "followers"})
        portal_project = Project.create({"name": "Zq portal", "privacy_visibility": "portal"})
        tasks = {
            "open": Task.create({"name": "Zq tarea abierta", "project_id": open_project.id}),
            "archived": Task.create({"name": "Zq tarea archivada", "project_id": open_project.id}),
            "private": Task.create({"name": "Zq tarea privada", "project_id": private_project.id}),
            "portal": Task.create({"name": "Zq tarea del portal", "project_id": portal_project.id}),
        }
        tasks["portal"].message_subscribe(partner_ids=portal.partner_id.ids)
        comment = self.env.ref("mail.mt_comment")
        note = self.env.ref("mail.mt_note")

        def post(task, body, subtype=comment, message_type="comment"):
            return self.env["mail.message"].create(
                {
                    "model": "project.task",
                    "res_id": task.id,
                    "message_type": message_type,
                    "subtype_id": subtype.id,
                    "subject": "Zqchatter",
                    "body": f"<p>{body}</p>",
                }
            )

        messages = {
            "open": post(tasks["open"], "zqcolectorax de la tarea abierta"),
            "archived": post(tasks["archived"], "zqcolectorax de la tarea archivada"),
            "private": post(tasks["private"], "zqcolectorax de la tarea privada"),
            "portal": post(tasks["portal"], "zqcolectorax para el cliente"),
            "note": post(tasks["portal"], "zqcolectorax nota interna", subtype=note),
            "notification": post(tasks["open"], "zqcolectorax aviso", message_type="user_notification"),
        }
        tasks["archived"].active = False
        self._index(self._chatter_config())
        return member, portal, tasks, messages

    def _chatter_config(self):
        """The chatter enabled for the messages these tests post (subject ``Zqchatter``)."""
        fields_ = self.env["ir.model.fields"].search(
            [("model", "=", "mail.message"), ("name", "in", ["subject", "body"])]
        )
        return self.Config.create(
            {
                "model_id": self.env["ir.model"]._get_id("mail.message"),
                "field_ids": [(6, 0, fields_.ids)],
                "domain": "[('subject', '=', 'Zqchatter')]",
                "append_only": True,
            }
        )

    def _comment(self, record, body):
        return self.env["mail.message"].create(
            {
                "model": record._name,
                "res_id": record.id,
                "message_type": "comment",
                "subtype_id": self.env.ref("mail.mt_comment").id,
                "subject": "Zqchatter",
                "body": f"<p>{body}</p>",
            }
        )

    def _chatter_ids(self, user, query="zqcolectorax", **kwargs):
        response = self._search(query, user=user, model="mail.message", limit=50, **kwargs)
        return response, {record["id"] for record in response["records"]}

    def test_the_chatter_is_found_through_the_documents_the_user_may_read(self):
        """An internal user finds the comments and notes of every task they may
        open, archived ones included, and nothing of a task of a project they
        were not invited to, nor a notification. And the search never asks the
        chatter for a whole domain: on a real database that loads every id."""
        member, _portal, _tasks, messages = self._chatter()
        message_class = type(self.env["mail.message"])
        original = message_class._search
        asked = []

        def recording(records, domain, offset=0, limit=None, order=None, **kwargs):
            if not records.env.is_superuser() and not kwargs.get("bypass_access"):
                asked.append(search_module.Domain(domain))
            return original(records, domain, offset, limit, order, **kwargs)

        with patch.object(message_class, "_search", recording):
            response, found = self._chatter_ids(member)
        expected = {messages[key].id for key in ("open", "archived", "portal", "note")}
        self.assertEqual(found, expected)
        # Nothing Odoo itself would not hand this user.
        readable = self.env(user=member)["mail.message"].search([("id", "in", list(found))])
        self.assertEqual(set(readable.ids), found)
        for record in response["records"]:
            self.assertEqual(record["res_model"], "project.task")
        for domain in asked:
            self.assertTrue(
                any(condition.field_expr == "id" for condition in domain.iter_conditions()),
                f"asked the chatter for a whole domain: {domain}",
            )

    def test_a_portal_user_finds_only_the_public_chatter_of_their_task(self):
        """Odoo's share filter: no internal note, even on a task the portal user
        follows, and nothing of the tasks they do not follow."""
        _member, portal, _tasks, messages = self._chatter()
        response, found = self._chatter_ids(portal)
        self.assertEqual(found, {messages["portal"].id})
        self.assertEqual(response["term_stats"]["zqcolectorax"]["df"], 1)
        readable = self.env(user=portal)["mail.message"].search([("id", "in", list(found))])
        self.assertEqual(set(readable.ids), found)

    def _indexed_task_comment(self, task, body):
        """A comment on ``task`` inside the domain of :meth:`_chatter`, indexed
        and below the cursor: only the index answers for it."""
        message = self.env["mail.message"].create(
            {
                "model": "project.task",
                "res_id": task.id,
                "message_type": "comment",
                "subtype_id": self.env.ref("mail.mt_comment").id,
                "subject": "Zqchatter",
                "body": f"<p>{body}</p>",
            }
        )
        config = self.Config.search([("model", "=", "mail.message")])
        self._index(config)
        self._catch_up(config)
        return config, message

    def test_a_message_deleted_in_the_chatter_stops_matching(self):
        """Odoo's "delete" in the chatter empties the body, it does not unlink.
        The index of the chatter is append_only, so without re-indexing on the
        write the old words would keep naming the message (and its ``df``)."""
        member, portal, tasks, _messages = self._chatter()
        config, message = self._indexed_task_comment(tasks["portal"], "la clave es zqborradox")
        for user in (member, portal):
            response, found = self._chatter_ids(user, "zqborradox")
            self.assertEqual(found, {message.id})

        tasks["portal"]._message_update_content(message, body="", attachment_ids=[])
        self.assertNotIn("zqborradox", message.body)
        for user in (member, portal):
            response, found = self._chatter_ids(user, "zqborradox")
            self.assertEqual(found, set(), "a deleted message still answers for its old words")
            self.assertEqual(response["term_stats"]["zqborradox"]["df"], 0)
        # Still indexed: its subject is text too.
        self.assertIn(message.id, self._indexed_ids(config))

    def test_an_edited_message_matches_its_new_words_only(self):
        member, portal, tasks, _messages = self._chatter()
        _config, message = self._indexed_task_comment(tasks["portal"], "presupuesto zqviejox")
        tasks["portal"]._message_update_content(message, body="<p>presupuesto zqnuevox</p>", attachment_ids=[])
        for user in (member, portal):
            response, found = self._chatter_ids(user, "zqviejox")
            self.assertEqual(found, set(), "the old words still match")
            self.assertEqual(response["term_stats"]["zqviejox"]["df"], 0)
            response, found = self._chatter_ids(user, "zqnuevox")
            self.assertEqual(found, {message.id}, "the new words do not match")
            self.assertEqual(response["term_stats"]["zqnuevox"]["df"], 1)

    def _age_row(self, config, message, seconds=5):
        """Make ``message`` and its index row look written by an earlier transaction."""
        message.flush_recordset()
        self.env.cr.execute(
            "UPDATE search_relevant_document SET source_write_date = source_write_date - %s * interval '1 second'"
            " WHERE config_id = %s AND res_id = %s",
            [seconds, config.id, message.id],
        )
        self.env.cr.execute(
            "UPDATE mail_message SET write_date = write_date - %s * interval '1 second' WHERE id = %s",
            [seconds, message.id],
        )
        message.invalidate_recordset()

    def _row_date(self, config, message):
        self.env.cr.execute(
            "SELECT source_write_date FROM search_relevant_document WHERE config_id = %s AND res_id = %s",
            [config.id, message.id],
        )
        return self.env.cr.fetchone()[0]

    def test_an_index_row_older_than_its_message_never_answers(self):
        """Whoever wins a race between an edit and the cron, a row built from
        an older version of the message holds text it may no longer have."""
        member, portal, tasks, _messages = self._chatter()
        _config, message = self._indexed_task_comment(tasks["portal"], "zqantiguox")
        self._later_write_date(message)
        for user in (member, portal):
            response, found = self._chatter_ids(user, "zqantiguox")
            self.assertEqual(found, set(), "a row older than its message answers")
            self.assertEqual(response["term_stats"]["zqantiguox"]["df"], 0)

    def test_pinning_a_message_keeps_it_found(self):
        """Any write moves ``write_date``; a write that leaves the text as it was
        only moves the date of its row, without reading nor tokenizing it."""
        member, portal, tasks, _messages = self._chatter()
        config, message = self._indexed_task_comment(tasks["portal"], "zqfijadox")
        self._age_row(config, message)
        original = text.build_tsvector
        calls = []

        def counting(*args, **kwargs):
            calls.append(args)
            return original(*args, **kwargs)

        with patch.object(text, "build_tsvector", counting):
            message.pinned_at = fields.Datetime.now()
            message.flush_recordset()
        self.assertEqual(calls, [], "pinning a message tokenized it again")
        self.assertEqual(self._row_date(config, message), message.write_date)
        for user in (member, portal):
            response, found = self._chatter_ids(user, "zqfijadox")
            self.assertEqual(found, {message.id}, "a pinned message drops out of the search")
            self.assertEqual(response["term_stats"]["zqfijadox"]["df"], 1)

    def test_pinning_does_not_revive_the_text_of_a_failed_reindex(self):
        """A "delete" whose re-index failed leaves the old text in a row older
        than its message. A later write that keeps the text must not give that
        row the new date: it is indexed again instead."""
        member, portal, tasks, _messages = self._chatter()
        config, message = self._indexed_task_comment(tasks["portal"], "zqrevivex")

        def broken(_config, _documents):
            raise psycopg2.errors.InternalError("index down")

        with (
            patch.object(SearchRelevantConfig, "_upsert_documents", broken),
            self.assertLogs(config_module.__name__, "ERROR"),
        ):
            tasks["portal"]._message_update_content(message, body="", attachment_ids=[])
        self.assertIn(message.id, self._indexed_ids(config))
        # In production the pin comes from a later transaction than the delete.
        self._later_write_date(message)
        message.invalidate_recordset()
        message.pinned_at = fields.Datetime.now()
        message.flush_recordset()
        for user in (member, portal):
            response, found = self._chatter_ids(user, "zqrevivex")
            self.assertEqual(found, set(), "pinning brought back the words of a deleted message")
            self.assertEqual(response["term_stats"]["zqrevivex"]["df"], 0)

    def test_an_archived_config_does_not_reindex_even_without_active_test(self):
        """The hook searches the configuration with the writer's context."""
        _member, _portal, tasks, _messages = self._chatter()
        config, message = self._indexed_task_comment(tasks["open"], "zqarchivadax")
        config.active = False
        calls = []
        with (
            patch.object(SearchRelevantConfig, "_reindex_ids", lambda _self, ids: calls.append(ids)),
            patch.object(SearchRelevantConfig, "_touch_documents", lambda _self, before: calls.append(before)),
        ):
            message.with_context(active_test=False).write({"body": "<p>zqotrax</p>"})
        self.assertEqual(calls, [])

    def test_a_null_write_date_on_one_side_only(self):
        """NULL is the oldest date: a message without it answers for a dated row,
        a NULL row never answers for a dated message, and the upsert replaces a
        NULL row but not a dated one with a NULL."""
        member, _portal, tasks, _messages = self._chatter()
        config, message = self._indexed_task_comment(tasks["open"], "zqunladox")
        written = self._row_date(config, message)
        self.env.cr.execute("UPDATE mail_message SET write_date = NULL WHERE id = %s", [message.id])
        self.assertEqual(self._chatter_ids(member, "zqunladox")[1], {message.id})

        self.env.cr.execute("UPDATE mail_message SET write_date = %s WHERE id = %s", [written, message.id])
        self.env.cr.execute(
            "UPDATE search_relevant_document SET source_write_date = NULL WHERE config_id = %s AND res_id = %s",
            [config.id, message.id],
        )
        self.assertEqual(self._chatter_ids(member, "zqunladox")[1], set())

        config._upsert_documents([(message.id, written, {"subject": "Zqchatter", "body": "<p>zqfechadox</p>"})])
        self.assertEqual(self._row_date(config, message), written)
        config._upsert_documents([(message.id, None, {"subject": "Zqchatter", "body": "<p>zqnulox</p>"})])
        self.assertEqual(self._row_date(config, message), written)
        self.assertEqual(self._chatter_ids(member, "zqfechadox")[1], {message.id})
        self.assertEqual(self._chatter_ids(member, "zqnulox")[1], set())

    def test_a_message_without_write_date_answers_and_is_reindexed(self):
        """Old messages may have no ``write_date``: a NULL is the oldest date,
        not an unknown one, both in the search and in the upsert."""
        member, _portal, tasks, _messages = self._chatter()
        config, message = self._indexed_task_comment(tasks["open"], "zqsinfechax")
        self.env.cr.execute("UPDATE mail_message SET write_date = NULL WHERE id = %s", [message.id])
        self.env.cr.execute(
            "UPDATE search_relevant_document SET source_write_date = NULL WHERE config_id = %s AND res_id = %s",
            [config.id, message.id],
        )
        message.invalidate_recordset()
        self.assertEqual(self._chatter_ids(member, "zqsinfechax")[1], {message.id})

        self.env.cr.execute("UPDATE mail_message SET body = '<p>zqreindexx</p>' WHERE id = %s", [message.id])
        message.invalidate_recordset()
        config._reindex_ids(message.ids)
        self.assertIsNone(self._row_date(config, message))
        self.assertEqual(self._chatter_ids(member, "zqreindexx")[1], {message.id})
        self.assertEqual(self._chatter_ids(member, "zqsinfechax")[1], set())

    def test_a_concurrency_error_while_reindexing_goes_up(self):
        """Odoo retries a request that hit a serialization failure; swallowing
        it would keep the old row of an append_only index for good."""
        _member, _portal, tasks, _messages = self._chatter()
        _config, message = self._indexed_task_comment(tasks["open"], "zqconcurrentex")

        def conflict(_self, _entries):
            raise psycopg2.errors.SerializationFailure("could not serialize access")

        with (
            patch.object(SearchRelevantConfig, "_insert_entries", conflict),
            self.assertRaises(psycopg2.errors.SerializationFailure),
        ):
            tasks["open"]._message_update_content(message, body="<p>zqotrox</p>", attachment_ids=[])

    def test_a_broken_index_does_not_break_the_write_of_a_message(self):
        """Any other error is logged and the write goes on: the row left behind
        is older than its message, so it never answers."""
        member, _portal, tasks, _messages = self._chatter()
        config, message = self._indexed_task_comment(tasks["open"], "zqrotox")
        domain = config.domain
        self.env.flush_all()
        self.env.cr.execute(
            "UPDATE search_relevant_config SET domain = %s WHERE id = %s", ["[('zq_no_such_field', '=', 1)]", config.id]
        )
        config.invalidate_recordset()
        with self.assertLogs(config_module.__name__, "ERROR") as logs:
            tasks["open"]._message_update_content(message, body="<p>zqnuevox</p>", attachment_ids=[])
        self.assertIn("could not re-index", logs.output[0])
        self.assertIn("zqnuevox", message.body)
        # In production the edit comes from a later transaction than the row.
        self._later_write_date(message)
        self.env.cr.execute("UPDATE search_relevant_config SET domain = %s WHERE id = %s", [domain, config.id])
        config.invalidate_recordset()
        self.assertEqual(self._chatter_ids(member, "zqrotox")[1], set())

    def test_an_sql_error_while_reindexing_leaves_the_transaction_usable(self):
        _member, _portal, tasks, _messages = self._chatter()
        _config, message = self._indexed_task_comment(tasks["open"], "zqsqlx")

        def failing(config, _ids):
            config.env.cr.execute("SELECT 1 / 0")

        with (
            patch.object(SearchRelevantConfig, "_reindex_ids", failing),
            mute_logger("odoo.sql_db"),
            self.assertLogs(config_module.__name__, "ERROR"),
        ):
            tasks["open"]._message_update_content(message, body="<p>zqdespuesx</p>", attachment_ids=[])
        message.invalidate_recordset()
        self.assertIn("zqdespuesx", message.body)

    def test_an_older_pass_does_not_undo_a_newer_row(self):
        """A pass that read the message before an edit commits after it: its
        upsert must not overwrite the row the edit wrote."""
        member, _portal, tasks, _messages = self._chatter()
        config, message = self._indexed_task_comment(tasks["portal"], "zqactualx")
        written = self._row_date(config, message)
        older = written - timedelta(seconds=5)
        config._upsert_documents([(message.id, older, {"subject": "Zqchatter", "body": "<p>zqpasadox</p>"})])
        self.assertEqual(self._row_date(config, message), written)
        self.assertEqual(self._chatter_ids(member, "zqactualx")[1], {message.id})
        self.assertEqual(self._chatter_ids(member, "zqpasadox")[1], set())

    def test_an_unlinked_message_never_answers_even_before_the_purge(self):
        """Its row stays until the daily purge, but every row is checked against
        ``mail_message`` by id: no record and no ``df``."""
        member, _portal, tasks, _messages = self._chatter()
        config, message = self._indexed_task_comment(tasks["open"], "zqunlinkx")
        message_id = message.id
        message.unlink()
        self.assertIn(message_id, self._indexed_ids(config))
        response, found = self._chatter_ids(member, "zqunlinkx")
        self.assertEqual(found, set())
        self.assertEqual(response["term_stats"]["zqunlinkx"]["df"], 0)

    def test_a_message_moved_to_another_document_follows_it(self):
        """Merging leads rewrites ``res_id`` and no text: nothing to re-index,
        because who may read a message is decided on its document as it is now."""
        member, portal, tasks, _messages = self._chatter()
        _config, message = self._indexed_task_comment(tasks["private"], "zqmovidox")
        for user in (member, portal):
            self.assertEqual(self._chatter_ids(user, "zqmovidox")[1], set())
        message.res_id = tasks["portal"].id
        for user in (member, portal):
            self.assertEqual(self._chatter_ids(user, "zqmovidox")[1], {message.id})

    def test_hidden_chatter_moves_nothing_in_the_answer(self):
        """Filling a task the user cannot open with the words they search must
        change neither the records, nor their order, nor a single count."""
        _member, portal, tasks, _messages = self._chatter()
        before, _found = self._chatter_ids(portal, "zqcolectorax zqsecretito")
        for n in range(5):
            self.env["mail.message"].create(
                {
                    "model": "project.task",
                    "res_id": tasks["private"].id,
                    "message_type": "comment",
                    "subtype_id": self.env.ref("mail.mt_comment").id,
                    "subject": "Zqchatter",
                    "body": f"<p>zqsecretito zqcolectorax {n}</p>",
                }
            )
        after, _found = self._chatter_ids(portal, "zqcolectorax zqsecretito")
        self.assertEqual([record["id"] for record in before["records"]], [record["id"] for record in after["records"]])
        self.assertEqual(before["term_stats"], after["term_stats"])
        self.assertEqual(before["terms"], after["terms"])
        self.assertEqual(before["coverage"]["state"], after["coverage"]["state"])

    def test_a_domain_through_a_hidden_message_is_not_an_oracle(self):
        """Regression: the caller's domain reaches a message they cannot
        read (``parent_id.body``). Whether that message says the word must not
        change the answer, nor raise."""
        _member, portal, _tasks, messages = self._chatter()
        mine = messages["portal"]
        mine.sudo().parent_id = messages["private"]
        domain = ["|", ("id", "=", mine.id), ("parent_id.body", "ilike", "zqsecretito")]
        answers = []
        for body in ("<p>zqsecretito zqcolectorax</p>", "<p>zqcolectorax</p>"):
            messages["private"].sudo().body = body
            answers.append(self._search("zqcolectorax", user=portal, model="mail.message", domain=domain, limit=50))
        self.assertEqual(answers[0]["records"], answers[1]["records"])
        self.assertEqual(answers[0]["term_stats"], answers[1]["term_stats"])

    def test_a_user_who_cannot_read_tasks_gets_no_error_and_no_chatter(self):
        """No access to the parent model: the model is left out of the scope, the
        way Odoo skips it, instead of failing."""
        member, _portal, _tasks, _messages = self._chatter()
        task_class = type(self.env["project.task"])
        original = task_class.has_access

        def no_tasks(records, operation):
            return False if records.env.uid == member.id else original(records, operation)

        with patch.object(task_class, "has_access", no_tasks):
            response, found = self._chatter_ids(member)
        self.assertEqual(found, set())
        self.assertEqual(response["term_stats"]["zqcolectorax"]["df"], 0)

    def test_a_record_rule_on_the_chatter_is_applied(self):
        """``bypass_access`` skips the record rules of ``mail.message`` too. A
        database that adds one gets it applied, and a message it hides moves no
        count."""
        member, _portal, tasks, _messages = self._chatter()
        self.env["ir.rule"].create(
            {
                "name": "Relevance search: hide restricted chatter",
                "model_id": self.env.ref("mail.model_mail_message").id,
                "groups": [(6, 0, [self.env.ref("project.group_project_user").id])],
                "domain_force": "[('subject', '!=', 'Zqchatter restringido')]",
            }
        )
        hidden = self.env["mail.message"].create(
            {
                "model": "project.task",
                "res_id": tasks["open"].id,
                "message_type": "comment",
                "subtype_id": self.env.ref("mail.mt_comment").id,
                "subject": "Zqchatter restringido",
                "body": "<p>zqcolectorax zqvedadox</p>",
            }
        )
        self.env["search.relevant.config"].search(
            [("model", "=", "mail.message")]
        ).domain = "[('subject', 'like', 'Zqchatter')]"
        self._index(self.Config.search([("model", "=", "mail.message")]))
        response, found = self._chatter_ids(member, "zqvedadox")
        self.assertNotIn(hidden.id, found)
        self.assertEqual(response["term_stats"]["zqvedadox"]["df"], 0)

    def test_a_task_of_another_company_is_not_searched(self):
        """The parent's ``_search`` runs with the caller's companies."""
        member, _portal, _tasks, _messages = self._chatter()
        project = self.env["project.project"].create(
            {"name": "Zq otra compañía", "privacy_visibility": "employees", "company_id": self.other_company.id}
        )
        task = self.env["project.task"].create(
            {"name": "Zq tarea ajena", "project_id": project.id, "company_id": self.other_company.id}
        )
        message = self.env["mail.message"].create(
            {
                "model": "project.task",
                "res_id": task.id,
                "message_type": "comment",
                "subtype_id": self.env.ref("mail.mt_comment").id,
                "subject": "Zqchatter",
                "body": "<p>zqcolectorax zqajenox</p>",
            }
        )
        self._index(self.Config.search([("model", "=", "mail.message")]))
        self.assertNotIn(member.company_ids, self.other_company)
        response, found = self._chatter_ids(member, "zqajenox")
        self.assertNotIn(message.id, found)
        self.assertEqual(response["term_stats"]["zqajenox"]["df"], 0)

    def test_the_chatter_of_any_document_is_searched_through_it(self):
        """Nobody chooses the documents: a message on a contact is found by
        whoever may read that contact, like a message on a task."""
        member, _portal, _tasks, _messages = self._chatter()
        partner = self.env["res.partner"].create({"name": "Zq contacto con chatter"})
        elsewhere = self.env["mail.message"].create(
            {
                "model": "res.partner",
                "res_id": partner.id,
                "message_type": "comment",
                "subtype_id": self.env.ref("mail.mt_comment").id,
                "subject": "Zqchatter",
                "body": "<p>zqcolectorax zqcontactox</p>",
            }
        )
        config = self.Config.search([("model", "=", "mail.message")])
        self._index(config)
        self.assertIn(elsewhere.id, self._indexed_ids(config))
        _response, found = self._chatter_ids(member, "zqcontactox")
        self.assertEqual(found, {elsewhere.id})

    def test_a_private_conversation_is_found_by_its_members_only(self):
        """An administrator's record rule reads every Discuss conversation; the
        search still only finds the ones the user belongs to."""
        member, _portal, _tasks, _messages = self._chatter()
        other = self.env["res.users"].create({"name": "Zq otro", "login": "search_relevant_other"})
        channel = (
            self.env["discuss.channel"]
            .with_user(member)
            ._create_group(partners_to=(member.partner_id | other.partner_id).ids, name="Zq grupo")
        )
        message = self.env["mail.message"].create(
            {
                "model": "discuss.channel",
                "res_id": channel.id,
                "message_type": "comment",
                "subtype_id": self.env.ref("mail.mt_comment").id,
                "subject": "Zqchatter",
                "body": "<p>zqcolectorax zqconfidencialx</p>",
            }
        )
        self._index(self.Config.search([("model", "=", "mail.message")]))
        _response, found = self._chatter_ids(member, "zqconfidencialx")
        self.assertEqual(found, {message.id})
        admin = self.env.ref("base.user_admin")
        self.assertTrue(self.env["discuss.channel"].with_user(admin).search_count([("id", "=", channel.id)]))
        response, found = self._chatter_ids(admin, "zqconfidencialx")
        self.assertEqual(found, set())
        self.assertEqual(response["term_stats"]["zqconfidencialx"]["df"], 0)

    def test_a_private_article_is_found_by_its_members_only(self):
        """An administrator's record rule reads every Knowledge article; the
        search only finds the comments of the ones they could read without it."""
        if "knowledge.article" not in self.env:
            self.skipTest("knowledge is not installed")
        Users = self.env["res.users"].with_context(no_reset_password=True)
        other = Users.create(
            {
                "name": "Zq autor",
                "login": "search_relevant_author",
                "group_ids": [(6, 0, [self.env.ref("base.group_user").id])],
            }
        )
        admin = self.env.ref("base.user_admin")
        Article = self.env["knowledge.article"]

        def private(owner, name):
            return Article.create(
                {
                    "name": name,
                    "internal_permission": "none",
                    "article_member_ids": [Command.create({"partner_id": owner.partner_id.id, "permission": "write"})],
                }
            )

        theirs = private(other, "Zq privado ajeno")
        mine = private(admin, "Zq privado propio")
        workspace = Article.create({"name": "Zq de todos", "internal_permission": "write"})
        self.assertEqual((theirs | mine | workspace).mapped("category"), ["private", "private", "workspace"])
        messages = {
            "theirs": self._comment(theirs, "zqarticulox zqajenox"),
            "mine": self._comment(mine, "zqarticulox zqpropiox"),
            "workspace": self._comment(workspace, "zqarticulox zqtodosx"),
        }
        self._index(self._chatter_config())
        self.assertTrue(Article.with_user(admin).search_count([("id", "=", theirs.id)]))
        response, found = self._chatter_ids(admin, "zqarticulox zqajenox")
        self.assertEqual(found, {messages["mine"].id, messages["workspace"].id})
        self.assertEqual(response["term_stats"]["zqajenox"]["df"], 0)
        _response, found = self._chatter_ids(other, "zqarticulox")
        self.assertEqual(found, {messages["theirs"].id, messages["workspace"].id})

    def test_a_private_event_is_found_by_its_attendees_only(self):
        """Every employee reads every event, but Odoo shows the messages of a
        private one only to who may edit it: its attendees and its organizer."""
        if "calendar.event" not in self.env:
            self.skipTest("calendar is not installed")
        Users = self.env["res.users"].with_context(no_reset_password=True)
        employee = self.env.ref("base.group_user")
        organizer, reader = (
            Users.create(
                {"name": f"Zq {login}", "login": f"search_relevant_{login}", "group_ids": [(6, 0, employee.ids)]}
            )
            for login in ("organizer", "reader")
        )
        start = datetime(2026, 1, 5, 10, 0)

        def event(name, privacy, attendees):
            return (
                self.env["calendar.event"]
                .with_user(organizer)
                .with_context(dont_notify=True)
                .create(
                    {
                        "name": name,
                        "start": start,
                        "stop": start + timedelta(hours=1),
                        "privacy": privacy,
                        "partner_ids": [(6, 0, (organizer.partner_id | attendees).ids)],
                    }
                )
            )

        events = {
            "public": event("Zq reunión abierta", "public", self.env["res.partner"]),
            "unset": event("Zq reunión sin privacidad", False, self.env["res.partner"]),
            "private": event("Zq reunión privada", "private", self.env["res.partner"]),
            "invited": event("Zq reunión privada con invitado", "private", reader.partner_id),
        }
        messages = {key: self._comment(record, f"zqeventox zq{key}x") for key, record in events.items()}
        self._index(self._chatter_config())
        self.assertTrue(self.env["calendar.event"].with_user(reader).search_count([("id", "=", events["private"].id)]))
        response, found = self._chatter_ids(reader, "zqeventox zqprivatex")
        self.assertEqual(found, {messages[key].id for key in ("public", "unset", "invited")})
        self.assertEqual(response["term_stats"]["zqprivatex"]["df"], 0)
        _response, found = self._chatter_ids(organizer, "zqeventox")
        self.assertEqual(found, {message.id for message in messages.values()})

    def test_a_user_who_reads_events_but_not_their_attendees_still_searches_the_chatter(self):
        """A portal user reads events but not their attendees: the lens must not
        need that read, or every chatter search of a portal user fails."""
        if "calendar.event" not in self.env:
            self.skipTest("calendar is not installed")
        _member, portal, _tasks, messages = self._chatter()
        start = datetime(2026, 1, 5, 10, 0)
        event = (
            self.env["calendar.event"]
            .with_context(dont_notify=True)
            .create({"name": "Zq evento", "start": start, "stop": start + timedelta(hours=1), "privacy": "private"})
        )
        self._comment(event, "zqcolectorax")
        self._index(self.Config.search([("model", "=", "mail.message")]))
        self.assertTrue(self.env["calendar.event"].with_user(portal).has_access("read"))
        with self.assertRaises(AccessError):
            self.env["calendar.attendee"].with_user(portal).search([])
        _response, found = self._chatter_ids(portal)
        self.assertEqual(found, {messages["portal"].id})

    def test_a_private_event_is_found_by_its_organizer_who_may_edit_it(self):
        """An organizer who left their own private event still finds its
        messages if they may edit events, as Odoo's write rule allows; without
        write access, they do not."""
        if "calendar.event" not in self.env:
            self.skipTest("calendar is not installed")
        organizer = (
            self.env["res.users"]
            .with_context(no_reset_password=True)
            .create(
                {
                    "name": "Zq organizador",
                    "login": "search_relevant_left_organizer",
                    "group_ids": [(6, 0, self.env.ref("base.group_user").ids)],
                }
            )
        )
        start = datetime(2026, 1, 5, 10, 0)
        event = (
            self.env["calendar.event"]
            .with_user(organizer)
            .with_context(dont_notify=True)
            .create(
                {
                    "name": "Zq reunión privada sin su organizador",
                    "start": start,
                    "stop": start + timedelta(hours=1),
                    "privacy": "private",
                    "partner_ids": [(6, 0, organizer.partner_id.ids)],
                }
            )
        )
        event.with_context(dont_notify=True).partner_ids = self.env.ref("base.partner_admin")
        self.assertEqual(event.user_id, organizer)
        self.assertNotIn(organizer.partner_id, event.partner_ids | event.attendee_ids.partner_id)
        message = self._comment(event, "zqorganizax")
        self._index(self._chatter_config())
        _response, found = self._chatter_ids(organizer, "zqorganizax")
        self.assertEqual(found, {message.id})

        self.env.ref("calendar.access_calendar_event_all_employee").perm_write = False
        self.assertFalse(self.env["calendar.event"].with_user(organizer).has_access("write"))
        self.assertTrue(self.env["calendar.event"].with_user(organizer).has_access("read"))
        response, found = self._chatter_ids(organizer, "zqorganizax")
        self.assertEqual(found, set())
        self.assertEqual(response["term_stats"]["zqorganizax"]["df"], 0)

    # ─── The chatter inside a document search ────────────────────────────

    def _task_chatter(self):
        """``_chatter`` plus the tasks themselves enabled: a task search now
        merges the messages of each task."""
        member, portal, tasks, messages = self._chatter()
        tasks_config = self._enable("project.task", ("name", "description"))
        self._index(tasks_config)
        return member, portal, tasks, messages, tasks_config

    def _post(self, record, body, subtype="mail.mt_comment", **values):
        return self.env["mail.message"].create(
            {
                "model": record._name,
                "res_id": record.id,
                "message_type": "comment",
                "subtype_id": self.env.ref(subtype).id,
                "subject": "Zqchatter",
                "body": f"<p>{body}</p>",
                **values,
            }
        )

    @staticmethod
    def _item(term, weight=1.0):
        return search_module.Item(term, text.quote_lexeme(term), None, weight)

    def _tasks(self, query, user, **kwargs):
        kwargs.setdefault("chatter", True)
        return self._search(query, user=user, model="project.task", **kwargs)

    def _chatter_index(self):
        return self.Config.search([("model", "=", "mail.message")])

    def test_a_task_is_found_through_its_comment_and_says_which(self):
        """The word is only in a comment: the task comes back, with ``via``
        pointing at that comment, read as the user."""
        member, _portal, tasks, messages, _config = self._task_chatter()
        response = self._tasks("zqcolectorax", member)
        self.assertEqual(response["coverage"]["chatter"], "searched")
        self.assertIn("chatter_indexed_until", response["coverage"])
        by_id = {record["id"]: record for record in self._mine(response)}
        # Archived, private and notification-only tasks stay out.
        self.assertEqual(set(by_id), {tasks["open"].id, tasks["portal"].id})
        via = by_id[tasks["open"].id]["via"]
        self.assertEqual(via["model"], "mail.message")
        self.assertEqual(via["id"], messages["open"].id)
        self.assertEqual(via["matched_terms"], ["zqcolectorax"])
        self.assertIn("zqcolectorax", via["snippet"])
        self.assertIsInstance(via["author"], str)
        self.assertRegex(via["date"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertFalse(via["email_from_outside"])
        self.assertEqual(set(via), {"model", "id", "author", "date", "email_from_outside", "matched_terms", "snippet"})
        self.assertIn(by_id[tasks["portal"].id]["via"]["id"], {messages["portal"].id, messages["note"].id})
        self.assertEqual(response["term_stats"]["zqcolectorax"]["df"], 2, "documents, not messages")
        # A mail that arrived says so.
        mail = self._post(tasks["open"], "zqcorreox llegado", message_type="email")
        self._index(self._chatter_index())
        (record,) = self._mine(self._tasks("zqcorreox", member))
        self.assertEqual(record["via"]["id"], mail.id)
        self.assertTrue(record["via"]["email_from_outside"])

    def test_a_task_found_by_its_fields_carries_no_via(self):
        member, _portal, tasks, _messages, config = self._task_chatter()
        tasks["open"].description = "<p>zqcolectorax también en la descripción</p>"
        self._later_write_date(tasks["open"])
        self._index(config)
        by_id = {record["id"]: record for record in self._mine(self._tasks("zqcolectorax", member))}
        self.assertNotIn("via", by_id[tasks["open"].id], "the message adds nothing the fields do not have")
        self.assertIn("via", by_id[tasks["portal"].id])

    def test_words_in_two_messages_do_not_add_up(self):
        """``score`` is the fields plus **one** message: a task that says both
        words in one comment beats one that says them in two."""
        member, _portal, tasks, _messages, _config = self._task_chatter()
        project = tasks["open"].project_id
        split, together = self.env["project.task"].create(
            [{"name": "Zq repartida", "project_id": project.id}, {"name": "Zq junta", "project_id": project.id}]
        )
        self._post(split, "zqalfax primero")
        self._post(split, "zqbetax después")
        self._post(together, "zqalfax y zqbetax juntos")
        self._index(self._chatter_index())
        records = self._mine(self._tasks("zqalfax zqbetax", member))
        self.assertEqual([record["id"] for record in records], [together.id, split.id])
        self.assertEqual(records[0]["score"], 1.0)
        self.assertLess(records[1]["score"], 1.0)

    def test_how_many_messages_match_only_breaks_ties(self):
        member, _portal, tasks, _messages, _config = self._task_chatter()
        project = tasks["open"].project_id
        many, one = self.env["project.task"].create(
            [{"name": "Zq muchas", "project_id": project.id}, {"name": "Zq una", "project_id": project.id}]
        )
        for n in range(3):
            self._post(many, f"zqgamax {n}")
        self._post(one, "zqgamax")
        self._index(self._chatter_index())
        records = self._mine(self._tasks("zqgamax", member))
        self.assertEqual([record["id"] for record in records], [many.id, one.id])
        self.assertEqual(records[0]["score"], records[1]["score"])

    def test_a_portal_user_never_finds_a_task_through_an_internal_note(self):
        """Odoo's share filter holds inside a task search: the note that says
        "nota" is not the ``via``, adds nothing to the score and is not counted."""
        _member, portal, tasks, messages, config = self._task_chatter()
        response = self._tasks("zqcolectorax nota", portal)
        (record,) = self._mine(response)
        self.assertEqual(record["id"], tasks["portal"].id)
        self.assertEqual(record["via"]["id"], messages["portal"].id)
        self.assertLess(record["score"], 1.0)
        self.assertEqual(response["term_stats"]["nota"]["df"], 0)
        self.assertEqual(response["term_stats"]["zqcolectorax"]["df"], 1)
        # Nothing Odoo would not hand this user.
        self.assertTrue(self.env(user=portal)["mail.message"].search([("id", "=", record["via"]["id"])]))
        # The first guard on its own, without the second one behind it: the
        # scope of the messages never holds the note.
        search = self.env(user=portal)["search.relevant"]
        tasks_model = self.env(user=portal)["project.task"]
        readable = [f for f in config._indexed_fields() if tasks_model._has_field_access(f, "read")]
        weights = search._readable_weights(config, readable)
        domain = search_module.Domain([])
        allowed = search._allowed_subquery(config, tasks_model, domain)
        live_entries, examined, _overflow = search._live_records(config, tasks_model, allowed, readable)
        msg_config, msg_readable = search._chatter_side(tasks_model)
        fused, _overflow = search._fused_scope(
            config, tasks_model, domain, allowed, weights, live_entries, examined, msg_config, msg_readable
        )
        self.assertEqual(search._fused_frequencies(fused, [("nota", None), ("zqcolectorax", None)]), [0, 1])
        self.assertEqual([row[4] for row in search._fused_page(fused, [self._item("nota")], 0, 10)], [])

    def test_hidden_messages_move_nothing_in_a_task_search(self):
        """Messages each user cannot read — an internal note for a portal user,
        a comment on a task they cannot open or on an archived one, a
        notification, one hidden by a record rule of ``mail.message`` — filled
        with the searched words change nothing in the answer: records, order,
        scores, ``via``, ``term_stats``, ``terms``, coverage, ``population``.
        Whether they are matched live or from the index."""
        member, portal, tasks, _messages, _config = self._task_chatter()
        self.env["ir.rule"].create(
            {
                "name": "Relevance search: hide restricted chatter",
                "model_id": self.env.ref("mail.model_mail_message").id,
                "domain_force": "[('subject', '!=', 'Zqchatter oculto')]",
            }
        )
        chatter = self._chatter_index()
        chatter.domain = "[('subject', 'like', 'Zqchatter')]"
        self._index(chatter)
        query = hidden = "zqcolectorax zqsecretito cliente pr-8841"

        def answers(users):
            return {user: self._tasks(query, user) for user in users}

        def unchanged(before):
            after = [answers(before)]  # the new messages read live
            self._index(chatter)
            after.append(answers(before))  # from the index, above the cursor
            self._catch_up(chatter)
            after.append(answers(before))  # below the cursor
            for user in before:
                self.assertTrue(before[user]["records"], "precondition: the search finds something")
                for n, answer in enumerate(after):
                    self.assertEqual(before[user], answer[user], f"{user.login}, step {n}")

        before = answers((member, portal))
        self.assertNotEqual(before[member]["records"], before[portal]["records"], "precondition: two scopes")
        self._post(tasks["private"], hidden)
        self._post(tasks["archived"], hidden)
        self._post(tasks["open"], hidden, message_type="user_notification")
        self._post(tasks["open"], hidden, subject="Zqchatter oculto")
        self._post(tasks["portal"], hidden, subject="Zqchatter oculto")
        unchanged(before)
        # An internal note: hidden from the portal user only.
        self._post(tasks["portal"], f"{hidden} nota", subtype="mail.mt_note")
        unchanged({portal: before[portal]})

    def test_the_agents_domain_narrows_the_messages_too(self):
        member, _portal, tasks, _messages, _config = self._task_chatter()
        response = self._tasks("zqcolectorax cliente", member, domain=[("id", "=", tasks["open"].id)])
        self.assertEqual(self._ids(response), [tasks["open"].id])
        self.assertEqual(response["term_stats"]["cliente"]["df"], 0, "the portal task's comment is out of the domain")

    def test_archived_tasks_stay_out_on_both_sides(self):
        member, _portal, tasks, _messages, _config = self._task_chatter()
        response = self._tasks("zqcolectorax archivada", member)
        self.assertNotIn(tasks["archived"].id, self._ids(response))
        self.assertEqual(response["term_stats"]["archivada"]["df"], 0)

    def test_without_read_access_to_messages_the_chatter_is_off(self):
        member, _portal, tasks, _messages, _config = self._task_chatter()
        message_class = type(self.env["mail.message"])
        original = message_class.has_access

        def no_messages(records, operation):
            return False if records.env.uid == member.id else original(records, operation)

        with patch.object(message_class, "has_access", no_messages):
            response = self._tasks("zqcolectorax abierta", member)
        self.assertEqual(response["coverage"]["chatter"], "off")
        self.assertEqual(response, self._tasks("zqcolectorax abierta", member, chatter=False))
        self.assertEqual(self._ids(response), [tasks["open"].id], "found by its name, not by its comment")
        self.assertNotIn("via", self._mine(response)[0])

    def test_a_model_that_redefines_how_odoo_guards_its_chatter_is_not_merged(self):
        """Fails closed: a redefinition of Odoo's rule for reading the messages
        of a document from a module nobody reviewed turns the chatter off for
        that model, without a list of models to keep. A private calendar event
        asks write access to read its messages, so it stays out."""
        member, _portal, tasks, _messages, _config = self._task_chatter()
        search = self.env["search.relevant"]
        self.assertTrue(search._chatter_guards_reviewed(self.env["project.task"]))
        task_class = type(self.env["project.task"])

        def stricter(records, message_operation):
            return dict.fromkeys(records, "write")

        with patch.object(task_class, "_mail_get_operation_for_mail_message_operation", stricter, create=True):
            self.assertFalse(search._chatter_guards_reviewed(self.env["project.task"]))
            response = self._tasks("zqcolectorax", member)
            fields_only = self._tasks("zqcolectorax", member, chatter=False)
        self.assertEqual(response["coverage"]["chatter"], "off")
        self.assertEqual(response, fields_only)
        self.assertNotIn(tasks["open"].id, self._ids(response))
        # The redefinitions known to leave reading alone, and the one that does not.
        for model, reviewed in (
            ("calendar.event", False),
            ("crm.lead", True),
            ("event.event", True),
            ("forum.post", True),
        ):
            if model in self.env:
                self.assertEqual(search._chatter_guards_reviewed(self.env[model]), reviewed, model)
        if "calendar.event" in self.env:
            self.assertIsNone(search._chatter_side(self.env["calendar.event"]))

    def test_a_via_the_users_own_search_refuses_answers_from_the_fields(self):
        """Second guard: every ``via`` goes through ``mail.message.search`` as
        the user. If it refuses one, the answer is the one of the fields alone,
        ``partial``, with the chatter ``off``."""
        member, _portal, tasks, messages, _config = self._task_chatter()
        message_class = type(self.env["mail.message"])
        original = message_class.search

        def refusing(records, domain, *args, **kwargs):
            found = original(records, domain, *args, **kwargs)
            return found - messages["open"] if records.env.uid == member.id else found

        with patch.object(message_class, "search", refusing):
            response = self._tasks("zqcolectorax abierta", member)
        fields_only = self._tasks("zqcolectorax abierta", member, chatter=False)
        self.assertEqual(self._ids(response), [tasks["open"].id], "found by its name")
        self.assertNotIn("via", self._mine(response)[0])
        self.assertEqual((response["coverage"]["chatter"], response["coverage"]["state"]), ("off", "partial"))
        self.assertNotIn("chatter_indexed_until", response["coverage"])
        response["coverage"]["state"] = fields_only["coverage"]["state"]
        self.assertEqual(response, fields_only)

    def test_a_live_message_the_users_own_search_refuses_is_never_read(self):
        """A message written after the last pass is read as the user only after
        their ``mail.message.search`` returns it. If it does not, the answer
        comes from the fields, instead of an ``AccessError`` for the search."""
        member, _portal, tasks, _messages, _config = self._task_chatter()
        fresh = self._post(tasks["open"], "zqrecientex zqvivox")
        message_class = type(self.env["mail.message"])
        search, read = message_class.search, message_class.read

        def refusing(records, domain, *args, **kwargs):
            found = search(records, domain, *args, **kwargs)
            return found - fresh if records.env.uid == member.id else found

        def forbidden(records, *args, **kwargs):
            if records.env.uid == member.id and fresh in records:
                raise AccessError("refused")
            return read(records, *args, **kwargs)

        with patch.object(message_class, "search", refusing), patch.object(message_class, "read", forbidden):
            response = self._tasks("zqvivox", member)
        self.assertEqual(self._mine(response), [])
        self.assertEqual((response["coverage"]["chatter"], response["coverage"]["state"]), ("off", "partial"))
        self.assertNotIn("chatter_indexed_until", response["coverage"])
        self.assertEqual(self._ids(self._tasks("zqvivox", member)), [tasks["open"].id], "precondition")

    def test_the_chatter_is_read_even_when_one_task_has_every_word(self):
        """No shortcut: a task with every word in its fields does not stop the
        chatter from being read, because a shorter task that says the rest in a
        comment can lead the answer."""
        member, _portal, tasks, _messages, config = self._task_chatter()
        project = tasks["open"].project_id
        filler = " ".join(f"palabra{n}" for n in range(300))
        full = self.env["project.task"].create(
            {"name": "Zq larga", "project_id": project.id, "description": f"<p>zqalfax {filler} zqbetax</p>"}
        )
        short = self.env["project.task"].create({"name": "zqalfax zqalfax", "project_id": project.id})
        self._index(config)
        self._post(short, "zqbetax en el comentario")
        self._index(self._chatter_index())
        response = self._tasks("zqalfax zqbetax", member)
        self.assertEqual(response["coverage"]["chatter"], "searched")
        records = self._mine(response)
        self.assertEqual([record["id"] for record in records], [short.id, full.id])
        self.assertEqual([record["score"] for record in records], [1.0, 1.0])
        self.assertIn("via", records[0])
        self.assertFalse(hasattr(search_module.SearchRelevant, "_one_record_has_every_word"))

    def test_the_configured_domain_holds_on_the_chatter_side(self):
        """A task the configuration's domain leaves out of the index does not come
        back through its comment either."""
        member, _portal, tasks, _messages = self._chatter()
        config = self._enable("project.task", ("name", "description"))
        config.domain = "[('name', 'not ilike', 'fuera')]"
        self._index(config)
        project = tasks["open"].project_id
        out = self.env["project.task"].create({"name": "Zq tarea fuera zqdominiox", "project_id": project.id})
        inside = self.env["project.task"].create({"name": "Zq tarea adentro", "project_id": project.id})
        self._post(out, "zqdominiox en el comentario")
        self._post(inside, "zqdominiox en el comentario")
        self._index(self._chatter_index())
        self._index(config)
        self.assertEqual(self._ids(self._tasks("zqdominiox", member, chatter=False)), [])
        response = self._tasks("zqdominiox", member)
        self.assertEqual(self._ids(response), [inside.id])
        self.assertEqual(response["term_stats"]["zqdominiox"]["df"], 1)
        # Read live too, before the chatter's next pass.
        self._post(out, "zqdominiovivox")
        self.assertEqual(self._ids(self._tasks("zqdominiovivox", member)), [])

    def test_the_answer_says_which_record_it_hangs_from_with_the_chatter_too(self):
        """``res_model`` and ``res_id`` do not depend on the chatter being merged."""
        member, _portal, tasks, _messages, config = self._task_chatter()
        config_class = type(config)
        original = config_class._parent_fields

        def pointing(configs):
            # project.task points at nothing: two plain fields stand in for the pair.
            return ("name", "id") if configs.model == "project.task" else original(configs)

        with patch.object(config_class, "_parent_fields", pointing):
            fields_only = self._mine(self._tasks("zqcolectorax abierta", member, chatter=False))
            merged = self._mine(self._tasks("zqcolectorax abierta", member))
        self.assertEqual(
            [(record["res_model"], record["res_id"]) for record in fields_only],
            [(tasks["open"].name, tasks["open"].id)],
        )
        by_id = {record["id"]: record for record in merged}
        self.assertEqual(
            (by_id[tasks["open"].id]["res_model"], by_id[tasks["open"].id]["res_id"]),
            (tasks["open"].name, tasks["open"].id),
        )
        for record in merged:
            self.assertIn("res_id", record)

    def test_a_comment_written_after_the_last_pass_is_found_live_and_then_indexed(self):
        member, _portal, tasks, _messages, _config = self._task_chatter()
        chatter = self._chatter_index()
        fresh = self._post(tasks["open"], "zqrecientex")
        live = self._tasks("zqrecientex", member)
        self.assertEqual([record["via"]["id"] for record in self._mine(live)], [fresh.id])
        self._index(chatter)
        self._catch_up(chatter)
        self.assertEqual(self._tasks("zqrecientex", member), live)

    def test_a_deleted_or_stale_comment_does_not_bring_its_task_back(self):
        """A comment emptied in the chatter, or whose index row is older than
        the message, neither brings its task in through ``via`` nor counts in
        ``df``, by its word or by a prefix, for an internal user and a portal
        one."""
        member, portal, tasks, _messages, _config = self._task_chatter()
        task = tasks["portal"]
        _chatter, deleted = self._indexed_task_comment(task, "zqborradox")
        _chatter, stale = self._indexed_task_comment(task, "zqantiguox")
        for user in (member, portal):
            for word in ("zqborradox", "zqantiguox", "zqantigu"):
                (record,) = self._mine(self._tasks(word, user))
                self.assertEqual(record["via"]["id"], stale.id if "antigu" in word else deleted.id, "precondition")
        task._message_update_content(deleted, body="", attachment_ids=[])
        self._later_write_date(stale)
        for user in (member, portal):
            for word in ("zqborradox", "zqantiguox", "zqantigu"):
                response = self._tasks(word, user)
                self.assertEqual(self._ids(response), [], word)
                stats = response["term_stats"][word]
                self.assertEqual((stats["df"], stats.get("prefix_df") or 0), (0, 0), word)

    def test_df_counts_documents_and_the_walk_of_the_messages_is_bounded(self):
        """``df`` counts tasks, not messages. The message index is walked newest
        first up to ``CHATTER_MAX_ROWS`` rows per word: reaching it leaves the
        answer ``complete``, what was walked is what answers, and the word
        counts as common."""
        member, _portal, tasks, _messages, _config = self._task_chatter()
        project = tasks["open"].project_id
        older, newer = self.env["project.task"].create(
            [{"name": "Zq vieja", "project_id": project.id}, {"name": "Zq nueva", "project_id": project.id}]
        )
        self._post(older, "zqrepetidox antes")
        for n in range(3):
            self._post(newer, f"zqrepetidox {n}")
        self._index(self._chatter_index())
        whole = self._tasks("zqrepetidox", member)
        self.assertEqual(whole["term_stats"]["zqrepetidox"]["df"], 2, "documents, not messages")
        self.assertEqual(set(self._ids(whole)), {older.id, newer.id})
        with patch.object(search_module, "CHATTER_MAX_ROWS", 3):
            walked = self._tasks("zqrepetidox", member)
        self.assertEqual(walked["coverage"]["state"], "complete", "reaching the bound is not partial")
        self.assertEqual(walked["coverage"]["chatter"], "searched")
        self.assertEqual(self._ids(walked), [newer.id], "the three newest messages are all the newer task's")
        self.assertEqual(walked["term_stats"]["zqrepetidox"]["df"], search_module.DF_CAP)
        # One row short of the bound: complete, and the same answer as without it.
        with patch.object(search_module, "CHATTER_MAX_ROWS", 5):
            self.assertEqual(self._tasks("zqrepetidox", member), whole)

    def test_a_common_word_does_not_take_the_rows_of_a_rare_one(self):
        """Each word walks its own ``CHATTER_MAX_ROWS`` rows: the only comment
        with a rare word, older than every comment with a common one, still
        brings its task in."""
        member, _portal, tasks, _messages, _config = self._task_chatter()
        project = tasks["open"].project_id
        rare, common = self.env["project.task"].create(
            [{"name": "Zq rara", "project_id": project.id}, {"name": "Zq comun", "project_id": project.id}]
        )
        self._post(rare, "zqcompresorx averiado")
        for n in range(8):
            self._post(common, f"zqgarantiax {n}")
        self._index(self._chatter_index())
        with patch.object(search_module, "CHATTER_MAX_ROWS", 3):
            response = self._tasks("zqgarantiax zqcompresorx", member)
        self.assertEqual(response["term_stats"]["zqcompresorx"]["df"], 1)
        by_id = {record["id"]: record for record in self._mine(response)}
        self.assertIn(rare.id, by_id)
        self.assertEqual(by_id[rare.id]["via"]["matched_terms"], ["zqcompresorx"])

    def test_messages_the_user_cannot_see_never_fill_the_bound(self):
        """The bound counts only rows the user may see: messages hidden from
        the user — a comment on a private task of someone else, on an archived
        task, in a Discuss conversation they are not in, on another model, a
        notification, and an internal note for a portal user — newer than the
        only visible comment and more than the bound, change nothing in the
        answer: records, order, scores, ``via``, ``term_stats`` (``df``
        included), ``terms`` and coverage. The visible comment still brings its
        task in, a word only they hold is still retried by prefix, and a code
        only they hold is still split."""
        member, portal, tasks, _messages, _config = self._task_chatter()
        chatter = self._chatter_index()
        visible = self._post(tasks["portal"], "zqoraculox para el cliente")
        self._index(chatter)
        queries = ("zqoraculox", "zqoraculo", "zqk-40417", "zqoraculox zqcolectorax", "zqoraculox zqk-40417")

        def answers(users):
            with patch.object(search_module, "CHATTER_MAX_ROWS", 3):
                return {(user, query): self._tasks(query, user) for user in users for query in queries}

        def unchanged(before):
            self._index(chatter)
            self._catch_up(chatter)
            after = answers({user for user, _query in before})
            for key, answer in before.items():
                self.assertEqual(after[key], answer, f"{key[0].login}: {key[1]}")

        before = answers((member, portal))
        for user in (member, portal):
            (record,) = self._mine(before[user, "zqoraculox"])
            self.assertEqual(record["via"]["id"], visible.id, "precondition")
            self.assertEqual(before[user, "zqoraculox"]["term_stats"]["zqoraculox"]["df"], 1, "precondition")
            stats = before[user, "zqoraculo"]["term_stats"]["zqoraculo"]
            self.assertEqual((stats["df"], stats["prefix"], stats["prefix_df"]), (0, "zqorac", 1), "precondition")
            self.assertNotIn("zqk-40417", before[user, "zqk-40417"]["terms"], "precondition: split")
        hidden = "zqoraculox zqk-40417 zqoraculoso"
        stranger = self.env["discuss.channel"].create({"name": "Zq ajeno", "channel_type": "group"})
        partner = self.env["res.partner"].create({"name": "Zq cliente ajeno"})
        for _n in range(4):
            self._post(tasks["private"], hidden)
            self._post(tasks["archived"], hidden)
            self._post(stranger, hidden)
            self._post(partner, hidden)
            self._post(tasks["open"], hidden, message_type="user_notification")
        unchanged(before)
        # An internal note: hidden from the portal user only.
        for _n in range(4):
            self._post(tasks["portal"], hidden, subtype="mail.mt_note")
        unchanged({key: answer for key, answer in before.items() if key[0] == portal})
        # Precondition: the hidden rows alone would fill the bound many times over.
        self.env.cr.execute(
            "SELECT count(*) FROM search_relevant_document WHERE config_id = %s AND tsv @@ %s::tsquery",
            [chatter.id, text.quote_lexeme("zqoraculox")],
        )
        self.assertGreater(self.env.cr.fetchone()[0], 20)

    def test_a_word_only_in_the_chatter_of_other_models_is_absent(self):
        """Rows of other models are outside the user's scope of a task search:
        however many there are, they do not reach the bound, and the word is
        absent (so it is retried by its prefix), not common."""
        member, _portal, _tasks, _messages, _config = self._task_chatter()
        partner = self.env["res.partner"].create({"name": "Zq cliente"})
        for n in range(4):
            self._post(partner, f"zqajenisimox {n}")
        self._index(self._chatter_index())
        with patch.object(search_module, "CHATTER_MAX_ROWS", 3):
            response = self._tasks("zqajenisimox", member)
        self.assertEqual(response["coverage"]["chatter"], "searched")
        stats = response["term_stats"]["zqajenisimox"]
        self.assertEqual((stats["df"], stats["prefix"], stats["prefix_df"]), (0, None, None))
        self.assertEqual(self._ids(response), [])

    def test_reaching_the_bound_leaves_the_answer_complete(self):
        """A word that reaches the bound counts ``DF_CAP`` but does not make
        the answer ``partial``, with the rest of the query found or not."""
        member, _portal, tasks, _messages, _config = self._task_chatter()
        for n in range(4):
            self._post(tasks["open"], f"zqfrecuentex {n}")
        self._index(self._chatter_index())
        self.assertEqual(self._tasks("zqfrecuentex", member)["coverage"]["state"], "complete", "precondition")
        with patch.object(search_module, "CHATTER_MAX_ROWS", 3):
            for query in ("zqfrecuentex", "zqfrecuentex zqcolectorax", "zqfrecuentex zqnadax"):
                response = self._tasks(query, member)
                self.assertEqual(response["term_stats"]["zqfrecuentex"]["df"], search_module.DF_CAP, query)
                self.assertEqual(
                    (response["coverage"]["chatter"], response["coverage"]["state"]), ("searched", "complete"), query
                )

    def test_words_that_name_the_kind_of_record_are_not_looked_for_in_the_messages(self):
        """They weigh 0: they cannot add to a score, so the messages are not
        walked for them, and a task whose comments only say "task" is not a
        candidate."""
        member, _portal, tasks, _messages, _config = self._task_chatter()
        self.assertIn("task", self.env["search.relevant"]._type_terms("project.task", "en_US"), "precondition")
        project = tasks["open"].project_id
        named, talked = self.env["project.task"].create(
            [{"name": "Zq zqtipox", "project_id": project.id}, {"name": "Zq otra", "project_id": project.id}]
        )
        for _n in range(3):
            self._post(talked, "task task")
        self._index(self._chatter_index())
        response = self._search("task zqtipox", user=member, model="project.task", chatter=True, limit=50)
        self.assertNotIn(talked.id, self._ids(response))
        self.assertIn(named.id, self._ids(response))
        self.assertEqual(
            response["term_stats"]["task"]["df"],
            self._tasks("task zqtipox", member, chatter=False)["term_stats"]["task"]["df"],
        )

    def test_prefixes_and_codes_are_counted_in_one_query_each(self):
        """The message side is the expensive one: the words retried by prefix
        are counted together, and so are the codes."""
        member, _portal, _tasks, _messages, _config = self._task_chatter()
        search_class = type(self.env["search.relevant"])
        original = search_class._fused_frequencies
        calls = []

        def counting(records, fused, bases, *args, **kwargs):
            calls.append(list(bases))
            return original(records, fused, bases, *args, **kwargs)

        with patch.object(search_class, "_fused_frequencies", counting):
            self._tasks("zqcolectoraxxx zqinexistentex ab-12345 cd-67890", member)
        self.assertEqual(len(calls), 3, calls)
        self.assertEqual(len(calls[0]), 2, "both codes at once")
        self.assertEqual(len([base for base in calls[2] if base[1]]), len(calls[2]), "only prefixes")
        self.assertGreaterEqual(len(calls[2]), 2, "both prefixes at once")

    def test_task_search_pages_are_exactly_the_full_ordering(self):
        """Pages of the merged ranking are the full order, ties included, and
        every score is the fields plus the best single message."""
        member, _portal, tasks, _messages, config = self._task_chatter()
        project = tasks["open"].project_id
        words = ["zqvalvulax", "zqbroncex", "zqesferax"]
        created = self.env["project.task"].create(
            [{"name": f"Zq {' '.join(words[: n % 3])}", "project_id": project.id} for n in range(36)]
        )
        for n, task in enumerate(created):
            for k in range(n % 4):
                self._post(task, " ".join(words[(n + k) % 3 : (n + k) % 3 + 1 + k % 2]))
        self._index(config)
        self._index(self._chatter_index())
        search = self.env(user=member)["search.relevant"]
        tasks_model = self.env(user=member)["project.task"]
        readable = config._indexed_fields()
        weights = search._readable_weights(config, readable)
        domain = search_module.Domain([])
        allowed = search._allowed_subquery(config, tasks_model, domain)
        live_entries, examined, _overflow = search._live_records(config, tasks_model, allowed, readable)
        chatter = self._chatter_index()
        msg_config, msg_readable = search._chatter_side(tasks_model)
        self.assertEqual(msg_config, chatter)
        fused, _overflow = search._fused_scope(
            config, tasks_model, domain, allowed, weights, live_entries, examined, msg_config, msg_readable
        )
        items, _frequencies, _stats, _population = search._search_items(
            config, tasks_model, words, weights, allowed, live_entries, examined, fused=fused
        )
        self.assertGreater(len({item.weight for item in items}), 1, "precondition: different weights")
        full = search._fused_page(fused, items, 0, 1000)
        self.assertGreater(len(full), 30)
        paged = []
        for offset, count in ((0, 7), (7, 1), (8, 13), (21, 100)):
            paged += search._fused_page(fused, items, offset, count)
        self.assertEqual(paged, full)
        # Independent of the SQL: fields plus the best single message.
        weight = {item.term: item.weight for item in items}
        for doc, score, _rank, n_msgs, via in full:
            task = self.env["project.task"].browse(doc)
            fields_hits = set(text.matched_terms(task.name, words))
            bodies = {
                message.id: set(text.matched_terms(message.body, words))
                for message in task.message_ids
                if message.subject == "Zqchatter" and message.message_type != "user_notification"
            }
            bodies = {key: hits for key, hits in bodies.items() if hits}
            best = max([sum(weight[w] for w in fields_hits | hits) for hits in bodies.values()], default=0)
            self.assertAlmostEqual(score, max(best, sum(weight[w] for w in fields_hits)), places=6)
            self.assertEqual(n_msgs, len(bodies))
            self.assertEqual(bool(via), best > sum(weight[w] for w in fields_hits) + 1e-9)

    def test_a_conversation_is_found_by_its_name_by_its_members_only(self):
        """The lens of the chatter applies to the fields too: an administrator's
        record rule reads every Discuss conversation, the search does not."""
        member, _portal, _tasks, _messages, _config = self._task_chatter()
        other = self.env["res.users"].create({"name": "Zq otro lente", "login": "search_relevant_other_lens"})
        channel = (
            self.env["discuss.channel"]
            .with_user(member)
            ._create_group(partners_to=(member.partner_id | other.partner_id).ids, name="Zq grupo zqlentex")
        )
        channels = self._enable("discuss.channel", ("name",))
        self._index(channels)
        self.assertEqual(
            [r["id"] for r in self._search("zqlentex", user=member, model="discuss.channel")["records"]],
            [channel.id],
        )
        admin = self.env.ref("base.user_admin")
        self.assertTrue(self.env["discuss.channel"].with_user(admin).search_count([("id", "=", channel.id)]))
        response = self._search("zqlentex", user=admin, model="discuss.channel")
        self.assertEqual(response["records"], [])
        self.assertEqual(response["term_stats"]["zqlentex"]["df"], 0)

    def test_the_tuqui_facade_merges_the_chatter_only_when_asked(self):
        """A backend that predates ``via`` gets the answer it knows."""
        member, _portal, tasks, _messages, _config = self._task_chatter()
        facade = self.env(user=member)["tuqui.search"]
        plain = facade.search_relevant("project.task", "zqcolectorax", limit=50)
        self.assertEqual(plain["coverage"]["chatter"], "off")
        self.assertNotIn(tasks["open"].id, [record["id"] for record in plain["records"]])
        merged = facade.search_relevant("project.task", "zqcolectorax", limit=50, options={"chatter": True})
        self.assertEqual(merged["coverage"]["chatter"], "searched")
        self.assertIn(tasks["open"].id, [record["id"] for record in merged["records"] if "via" in record])

    def test_timings_come_back_only_to_an_administrator_who_asks(self):
        """How long a phase takes grows with rows the caller may not see: for
        anybody else the flag is ignored."""
        member, portal, _tasks, _messages, _config = self._task_chatter()
        admin = self.env.ref("base.user_admin")
        self.assertNotIn("timings", self._tasks("zqcolectorax", admin))
        for user in (member, portal):
            env = self.env(user=user, context={"search_relevant_timings": True})
            self.assertNotIn("timings", env["search.relevant"].search_relevant("project.task", "zqcolectorax"))
        env = self.env(user=admin, context={"search_relevant_timings": True})
        response = env["search.relevant"].search_relevant("project.task", "zqcolectorax", chatter=True)
        self.assertLessEqual({"scope", "terms", "rank", "via_check", "describe", "total"}, set(response["timings"]))
        self.assertTrue(all(isinstance(value, float) for value in response["timings"].values()))
        response = env["search.relevant"].search_relevant("project.task", "zqcolectorax")
        self.assertLessEqual({"scope", "terms", "rank", "describe", "total"}, set(response["timings"]))

    def test_the_engine_merges_the_chatter_only_when_asked(self):
        """One default, off: a caller that does not ask gets the fields only."""
        member, _portal, tasks, _messages, _config = self._task_chatter()
        response = self.env(user=member)["search.relevant"].search_relevant("project.task", "zqcolectorax", limit=50)
        self.assertEqual(response["coverage"]["chatter"], "off")
        self.assertNotIn("chatter_indexed_until", response["coverage"])
        self.assertNotIn(tasks["open"].id, self._ids({**response, "_model": "project.task"}))
        self.assertEqual(self._tasks("zqcolectorax", member)["coverage"]["chatter"], "searched")

    def test_the_chatter_starts_with_a_domain_you_can_see(self):
        """No filter hidden behind: what the chatter indexes is the domain the
        screen shows, and messages are written once."""
        if self.Config.with_context(active_test=False).search([("model", "=", "mail.message")]):
            self.skipTest("the chatter is already enabled in this database")
        fields_ = self.env["ir.model.fields"].search([("model", "=", "mail.message"), ("name", "=", "body")])
        config = self.Config.create(
            {"model_id": self.env["ir.model"]._get_id("mail.message"), "field_ids": [(6, 0, fields_.ids)]}
        )
        self.assertEqual(config.domain, config_module.MODEL_DEFAULTS["mail.message"]["domain"])
        self.assertTrue(config.append_only)

    def test_models_that_filter_in_python_cannot_be_enabled(self):
        """Their ``_search`` drops ids in Python and there is no document to
        scope them through."""
        for model in ("ir.attachment", "mail.activity", "mail.scheduled.message"):
            if model not in self.env:
                continue
            fields_ = self.env["ir.model.fields"].search([("model", "=", model), ("ttype", "in", ["char", "text"])])
            with self.assertRaises(ValidationError, msg=model):
                self.Config.create(
                    {"model_id": self.env["ir.model"]._get_id(model), "field_ids": [(6, 0, fields_[:1].ids)]}
                )

    def test_archived_records_do_not_come_back(self):
        config = self._enable()
        archived = self.env["res.partner"].create({"name": "Archivado mandarinox"})
        active = self.env["res.partner"].create({"name": "Mandarinox activa"})
        more_archived = self.env["res.partner"].create(
            [{"name": "Mandarinox"} for _n in range(10)]
        )  # shorter: rank first
        self._index(config)
        (archived | more_archived).active = False
        self._index(config)
        # The ranking itself leaves them out: archived records ranking first must
        # not eat the candidates the active one needs.
        with patch.object(search_module, "MAX_CANDIDATES", 5), patch.object(search_module, "MAX_WINDOW", 5):
            self.assertEqual(self._ids(self._search("mandarinox", limit=50)), [active.id])
        # Each guard on its own: the final check still drops it when the ranking
        # subquery lets archived records through.
        search_class = type(self.env["search.relevant"])

        def with_archived(search, _config, records_model, domain):
            return records_model.with_context(active_test=False)._search(domain).subselect()

        with patch.object(search_class, "_allowed_subquery", with_archived):
            self.assertEqual(self._ids(self._search("mandarinox", limit=50)), [active.id])

    def test_a_model_index_never_answers_for_another_model(self):
        """Ids repeat across models: a category and a partner can share one."""
        partners = self._enable()
        categories = self._enable("res.partner.category", ("name",))
        # Give the category the id of a partner the user sees.
        partner = self.both_terms
        self.assertFalse(self.env["res.partner.category"].browse(partner.id).exists())
        self.env.cr.execute("SELECT setval('res_partner_category_id_seq', %s, false)", [partner.id])
        category = self.env["res.partner.category"].create({"name": "Cuarzocat"})
        self.assertEqual(category.id, partner.id, "precondition: same id in both models")
        self._index(partners)
        self._index(categories)
        self.assertEqual(self._mine(self._search("cuarzocat")), [])
        self.assertEqual(self._ids(self._search("cuarzocat", model="res.partner.category")), [category.id])

    def test_words_in_a_field_the_user_cannot_read_do_not_match(self):
        """Regression: a portal user confirmed the content of ``partner_phone``
        through a result with ``matched_terms: []``."""
        config = self._enable()
        self._index(config)
        with self._cannot_read(self.user, "res.partner", "comment"):
            # "trifásico" is only in the comment of both_terms.
            self.assertEqual(self._mine(self._search("trifásico")), [])
            response = self._search("bomba siemens")
            self.assertEqual(response["coverage"]["fields"], ["name"])
            record = next(r for r in response["records"] if r["id"] == self.both_terms.id)
            self.assertEqual(record["matched_terms"], ["bomba"])
            self.assertNotIn("Siemens", record["snippet"], "the fragment must not show the unreadable field")
        # Everyone else still finds it by the comment.
        self.assertIn(self.both_terms.id, self._ids(self._search("trifásico", user=self.env.ref("base.user_admin"))))

    def test_records_and_snippets_are_read_as_the_user(self):
        """N6: the fragment is built from the user's own read, never a sudo one."""
        config = self._enable()
        self._index(config)
        fresh = self.env["res.partner"].create({"name": "Recién leído pitahaya"})
        partner_class = type(self.env["res.partner"])
        original = partner_class.read
        reads = []

        def spy(records, fields=None, load="_classic_read"):
            reads.append((records.env.su, records.env.uid, set(records.ids)))
            return original(records, fields, load)

        with patch.object(partner_class, "read", spy), self._cannot_read(self.user, "res.partner", "comment"):
            response = self._search("pitahaya bomba")
        self.assertEqual(set(self._ids(response)), {fresh.id, self.both_terms.id})
        self.assertTrue(reads)
        self.assertEqual({(su, uid) for su, uid, _ids in reads}, {(False, self.user.id)})
        snippet = next(r["snippet"] for r in response["records"] if r["id"] == self.both_terms.id)
        self.assertNotIn("Siemens", snippet, "no text of a field the user cannot read")

    def test_freshness_never_returns_what_the_user_cannot_see(self):
        """N6: a record written after the last pass that the user cannot see is
        neither returned nor even examined — asserted, not just an error."""
        config = self._enable()
        self._index(config)
        visible = self.env["res.partner"].create({"name": "Visible frambuesa"})
        hidden = self.env["res.partner"].create({"name": "Oculto frambuesa", "company_id": self.other_company.id})

        search = self.env(user=self.user)["search.relevant"]
        partners = self.env(user=self.user)["res.partner"]
        allowed = search._allowed_subquery(config, partners, search_module.Domain([]))
        partner_class = type(self.env["res.partner"])

        def unchecked_read(records, fields=None, load="_classic_read"):
            return [{"id": res_id, **{name: False for name in fields or []}} for res_id in records.ids]

        with patch.object(partner_class, "read", unchecked_read):
            _entries, examined, _overflow = search._live_records(config, partners, allowed, config._indexed_fields())
        self.assertIn(visible.id, examined)
        self.assertNotIn(hidden.id, examined)
        # And end to end, the hidden one is not in the answer.
        self.assertEqual(self._ids(self._search("frambuesa", limit=50)), [visible.id])

    def test_the_index_table_is_not_readable_through_the_orm(self):
        config = self._enable()
        self._index(config)
        for user in (self.user, self.env.ref("base.user_admin")):
            documents = self.env(user=user)["search.relevant.document"]
            with self.assertRaises(AccessError), mute_logger("odoo.addons.base.models.ir_model"):
                documents.search([])
            with self.assertRaises(AccessError), mute_logger("odoo.addons.base.models.ir_model"):
                documents.search_read([], ["res_id"])
        with self.assertRaises(AccessError), mute_logger("odoo.addons.base.models.ir_model"):
            self.env(user=self.user)["search.relevant.config"].search([])

    def test_a_user_without_read_access_to_the_model_is_refused(self):
        portal = self.env["res.users"].create(
            {
                "name": "Relevance Search Portal",
                "login": "search_relevant_portal",
                "group_ids": [(6, 0, [self.env.ref("base.group_portal").id])],
            }
        )
        # Same refusal whether the model is enabled or not: that is not his to know.
        for enable in (False, True):
            if enable:
                self._enable("res.partner.category", ("name",))
            with self.assertRaises(AccessError), mute_logger("odoo.addons.base.models.ir_model"):
                self._search("anything", user=portal, model="res.partner.category")

    # ─── Ranking ─────────────────────────────────────────────────────────

    def test_more_distinct_terms_rank_first(self):
        config = self._enable()
        self._index(config)
        response = self._search("motor siemens")
        ids = self._ids(response)
        self.assertLess(ids.index(self.both_terms.id), ids.index(self.one_term.id))
        scores = [record["score"] for record in response["records"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertTrue(all(0 <= score <= 1 for score in scores))
        self.assertEqual(self._mine(response)[0]["id"], self.both_terms.id)
        self.assertEqual(self._mine(response)[0]["matched_terms"], ["motor", "siemens"])

    def test_ranking_pages_are_exactly_the_full_ordering(self):
        """``_rank_page`` computes ``ts_rank_cd`` only for the top tier of each
        page; the pages must still be the full weighted ordering, ties included."""
        config = self._enable()
        self.env["res.partner"].create(
            [{"name": f"Válvula {'esférica ' * (n % 3)}bronce {n}", "comment": "válvula " * (n % 2)} for n in range(40)]
        )
        self._index(config)
        search = self.env["search.relevant"]
        partners = self.env["res.partner"].sudo()
        everything = partners._search([]).subselect()
        items, _frequencies, _stats, _population = search._search_items(
            config, partners, ["valvula", "esferica", "bronce"], "", everything, []
        )
        self.assertGreater(len({item.weight for item in items}), 1, "precondition: different weights")
        any_term = " | ".join(item.operand for item in items)
        self.env.cr.execute(
            SQL(
                """
                SELECT res_id, %s, ts_rank_cd(%s::float4[], tsv, %s::tsquery, 33) FROM search_relevant_document d
                 WHERE config_id = %s AND tsv @@ %s::tsquery
                """,
                SQL(", ").join(SQL("(tsv @@ %s::tsquery)::int", item.operand) for item in items),
                search_module.RANK_WEIGHTS,
                any_term,
                config.id,
                any_term,
            )
        )
        rows = self.env.cr.fetchall()
        scored = [
            (res_id, sum(item.weight * hit for item, hit in zip(items, hits, strict=True)), rank)
            for res_id, *hits, rank in rows
        ]
        expected = [res_id for res_id, score, rank in sorted(scored, key=lambda r: (-r[1], -r[2], -r[0]))]
        self.assertGreater(len(expected), 30)
        paged = []
        for offset, count in ((0, 7), (7, 1), (8, 13), (21, 100)):
            paged += [row[0] for row in search._rank_page(config, items, items, everything, [], offset, count)]
        self.assertEqual(paged, expected)

    def test_common_terms_never_hide_records_that_match_them(self):
        """Regression: 25.000 records with "odoo" and "tuqui" →
        'odoo tuqui zzzinexistente' came back empty. The candidates of the
        rare-terms shortcut must never change the answer.

        Made-up words, so no record of the database can match them and the
        whole answer — not only the records created here — is asserted."""
        config = self._enable()
        common = self.env["res.partner"].create([{"name": f"Quenapo tatabro soporte {n}"} for n in range(20)])
        rare = self.env["res.partner"].create({"name": "Zorzalito solo"})
        self._index(config)
        queries = ("quenapo tatabro zorzalito", "quenapo zorzalito", "tatabro soporte zorzalito")

        def answer(query):
            return [(r["id"], r["score"]) for r in self._search(query, limit=50)["records"]]

        search_class = type(self.env["search.relevant"])
        original = search_class._rank_page
        shortened = []

        def spy(search, config, items, anchor, *args, **kwargs):
            shortened.append(len(anchor) < len(items))
            return original(search, config, items, anchor, *args, **kwargs)

        # A low cap makes "quenapo" and "tatabro" common, so they stop bringing in
        # candidates. The weights are the same in both runs: only the shortcut changes.
        with patch.object(search_module, "DF_CAP", 5):
            with patch.object(search_class, "_rank_page", spy):
                response = self._search("quenapo tatabro zzzinexistente", limit=50)
                self.assertEqual({record["id"] for record in response["records"]}, set(common.ids))
                self.assertEqual({tuple(r["matched_terms"]) for r in response["records"]}, {("quenapo", "tatabro")})
                shortcut = [answer(query) for query in queries]
            self.assertTrue(any(shortened), "precondition: the shortcut kicks in")
            with patch.object(search_class, "_anchor_items", lambda search, items, frequencies: items):
                full = [answer(query) for query in queries]
        self.assertEqual(shortcut, full, "the shortcut must not change any answer")
        self.assertEqual({res_id for res_id, _score in full[0]}, set(common.ids) | {rare.id})

    def test_the_weight_of_a_term_is_the_one_the_caller_uses(self):
        """One weight function shared with the Tuqui backend, so the ranking and
        the confidence signal never disagree about which word carries the query."""
        self.assertEqual(search_module.term_weight(3, 1000, False), round(math.log(1 + 1000 / 4), 6))
        self.assertEqual(search_module.term_weight(0, 1000, True), 0.0, "a word naming the record type")
        common = search_module.term_weight(search_module.DF_CAP * 20, 1000, False)
        self.assertEqual(common, search_module.term_weight(search_module.DF_CAP, 1000, False), "df caps")
        self.assertLess(common, search_module.term_weight(1, 1000, False))

    def test_a_word_in_the_title_breaks_the_tie(self):
        """Same word, same weight: the record with it in the name comes first."""
        config = self._enable()
        body = self.env["res.partner"].create({"name": "Registro sin marca", "comment": "<p>zqtitulox</p>"})
        title = self.env["res.partner"].create({"name": "Zqtitulox en el nombre", "comment": "<p>otro texto</p>"})
        self._index(config)
        self.assertEqual(self._ids(self._search("zqtitulox")), [title.id, body.id])

    def test_rare_terms_outweigh_common_ones(self):
        """Real case (bench on a production copy, 2026-09-15): "la tarea de gap
        analysis del proyecto Friolandia" lost "Gap Analisis - Friolandia" to tasks
        with "tarea" + "proyecto" + "gap", because every term weighed the same."""
        config = self._enable()
        self.env["res.partner"].create([{"name": f"Tarea del proyecto gap {n}"} for n in range(60)])
        target = self.env["res.partner"].create({"name": "Gap Analisis - Friolandia"})
        self._index(config)
        response = self._search("la tarea de gap analysis del proyecto Friolandia")
        self.assertEqual(self._ids(response)[0], target.id)
        self.assertEqual(self._mine(response)[0]["matched_terms"], ["gap", "friolandia"])
        scores = [record["score"] for record in response["records"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertTrue(all(0 <= score <= 1 for score in scores))

    def test_rarity_is_counted_inside_the_users_scope(self):
        """A word common in the database and rare for this user must weigh as rare
        for this user."""
        config = self._enable()
        self.env["res.partner"].create(
            [{"name": f"Pomeloz hidden {n}", "company_id": self.other_company.id} for n in range(30)]
        )
        self.env["res.partner"].create({"name": "Pomeloz visible"})
        self._index(config)
        search = self.env["search.relevant"]
        admin_partners = self.env["res.partner"].sudo()
        user_partners = self.env(user=self.user)["res.partner"]
        _items, admin_df, _stats, _population = search._search_items(
            config,
            admin_partners,
            ["pomeloz"],
            "",
            admin_partners._search([]).subselect(),
            [],
        )
        _items, user_df, _stats, _population = search._search_items(
            config, user_partners, ["pomeloz"], "", user_partners._search([]).subselect(), []
        )
        self.assertEqual((admin_df["pomeloz"], user_df["pomeloz"]), (31, 1))

    def test_term_stats_count_only_what_the_user_may_see(self):
        """Confidence signal: df per term inside the user's scope, as a count and
        nothing else — hidden records change no number the user gets."""
        config = self._enable()
        self.env["res.partner"].create(
            [{"name": f"Zqpomeloz zqquinquejas ocultas {n}", "company_id": self.other_company.id} for n in range(7)]
        )
        self.env["res.partner"].create({"name": "Zqpomeloz zqquinqueja visible"})
        self._index(config)
        query = "zqpomeloz zqquinquejaz contact"
        admin = self.env.ref("base.user_admin")
        admin.company_ids = [(4, self.other_company.id)]
        admin_env = self.env(user=admin, context={"allowed_company_ids": [self.main_company.id, self.other_company.id]})
        admin_stats = admin_env["search.relevant"].search_relevant("res.partner", query)["term_stats"]
        response = self._search(query)
        user_stats = response["term_stats"]
        self.assertNotIn("term_stats_df_cap", response, "the cap is documented, not sent every time")
        self.assertGreaterEqual(response["population"], 1)
        self.assertEqual(admin_stats["zqpomeloz"]["df"], 8)
        self.assertEqual(user_stats["zqpomeloz"], {"df": 1, "type": False, "prefix": None, "prefix_df": None})
        # Resolved by prefix: the exact word is nowhere, "zqquinque" is in the one it sees.
        self.assertEqual(user_stats["zqquinquejaz"], {"df": 0, "type": False, "prefix": "zqquinque", "prefix_df": 1})
        self.assertEqual(admin_stats["zqquinquejaz"]["prefix_df"], 8)
        self.assertTrue(user_stats["contact"]["type"])
        # A portal user sees none of those partners.
        portal = self.env["res.users"].create(
            {
                "name": "Relevance Search Portal Stats",
                "login": "search_relevant_portal_stats",
                "group_ids": [(6, 0, [self.env.ref("base.group_portal").id])],
            }
        )
        portal_stats = self._search(query, user=portal)["term_stats"]
        self.assertEqual(portal_stats["zqpomeloz"]["df"], 0)
        self.assertIsNone(portal_stats["zqquinquejaz"]["prefix"])
        # Only these keys, only these kinds of values, for every term.
        for stats in user_stats.values():
            self.assertEqual(set(stats), {"df", "type", "prefix", "prefix_df"})
            self.assertIsInstance(stats["df"], int)
        # The user's df is exactly what the user's own search finds.
        visible = self.env(user=self.user)["res.partner"].search_count([("name", "ilike", "zqpomeloz")])
        self.assertEqual(user_stats["zqpomeloz"]["df"], visible)
        # Records read live count too, and still only the visible ones.
        self.env["res.partner"].create({"name": "Zqpomeloz recien creado"})
        self.env["res.partner"].create({"name": "Zqpomeloz oculto recien", "company_id": self.other_company.id})
        self.assertEqual(self._search(query)["term_stats"]["zqpomeloz"]["df"], 2)

    def test_words_naming_the_record_type_weigh_least(self):
        """S3: the model's description and the many2one comodels of its search
        view name what is searched, not what the record says."""
        config = self._enable()
        self.assertIn("contact", self.env["search.relevant"]._type_terms("res.partner", "en_US"))
        self.env["res.partner"].create([{"name": "Friolandix uno"}, {"name": "Friolandix dos"}])
        loner = self.env["res.partner"].create({"name": "Contact solitario zzq"})
        self._index(config)
        response = self._search("contact friolandix")
        self.assertNotEqual(self._ids(response)[0], loner.id, "a rare type word does not outrank content")
        self.assertIn(loner.id, self._ids(response), "it still counts")

    def test_a_term_nothing_has_is_retried_by_prefix(self):
        """S4: plural and inflection, not translation."""
        config = self._enable()
        record = self.env["res.partner"].create({"name": "Quinqueja mensual"})
        spanish = self.env["res.partner"].create({"name": "Informe Analisix"})
        self._index(config)
        response = self._search("quinquejas")
        self.assertEqual(self._ids(response), [record.id])
        self.assertEqual(self._mine(response)[0]["matched_terms"], ["quinquejas"])
        self.assertNotIn(spanish.id, self._ids(self._search("analysix")), "analysix is not analisix")

    # ─── Normalization ───────────────────────────────────────────────────

    def test_accents_and_case_do_not_matter(self):
        config = self._enable()
        record = self.env["res.partner"].create({"name": "Conciliación Bancaria de Ñandú"})
        self._index(config)
        for query in ("CONCILIACION bancária", "conciliación BANCARIA", "nandu"):
            self.assertEqual(self._ids(self._search(query))[:1], [record.id], query)
        response = self._search("Conciliacion Bancaria")
        self.assertEqual(self._mine(response)[0]["matched_terms"], ["conciliacion", "bancaria"])
        self.assertIn("Conciliación Bancaria", self._mine(response)[0]["snippet"])

    def test_codes_split_on_hyphens_dots_and_slashes(self):
        """Regression: 'PR-979' was indexed as '-979' and "979" did not find it.
        A code is searched whole first, then by its parts with digits.

        Made-up numbers: whether a code falls back depends on whether any record
        of the database has it, so they must not exist outside this test."""
        config = self._enable()
        spaced = self.env["res.partner"].create({"name": "Revisión PR 97913 aprobada"})
        hyphen = self.env["res.partner"].create(
            {"name": "PR-98024 listo", "comment": "<p>ver wiki.zorzalhost.inc y inv/2024/00731</p>"}
        )
        furn = self.env["res.partner"].create({"name": "Caja FURN_78156"})
        furnx = self.env["res.partner"].create({"name": "Caja FURNX78156"})
        self._index(config)
        # Whole code found: searched whole.
        response = self._search("PR-98024")
        self.assertEqual((response["terms"], self._ids(response)), (["pr-98024"], [hyphen.id]))
        # No record has "PR-97913" whole: falls back to its part with digits.
        response = self._search("PR-97913")
        self.assertEqual((response["terms"], self._ids(response)), (["97913"], [spaced.id]))
        self.assertEqual(self._ids(self._search("98024")), [hyphen.id])
        self.assertEqual(self._ids(self._search("zorzalhost")), [hyphen.id])
        self.assertEqual(self._ids(self._search("00731")), [hyphen.id])
        self.assertEqual(self._ids(self._search("inv/2024/00731")), [hyphen.id])
        self.assertEqual(self._ids(self._search("FURN_78156")), [furn.id], "FURN_78156 does not match FURNX78156")
        self.assertEqual(self._ids(self._search("furnx78156")), [furnx.id])
        # A hidden record with the code must not stop the fallback, nor show.
        self.env["res.partner"].create({"name": "PR-97913 secreto", "company_id": self.other_company.id})
        self._index(config)
        response = self._search("PR-97913")
        self.assertEqual((response["terms"], self._ids(response)), (["97913"], [spaced.id]))

    def test_the_answer_says_which_terms_were_searched(self):
        """Regression: 'de la' answered complete and empty, and the agent was told
        it was a real "not found"."""
        config = self._enable()
        self._index(config)
        for query in ("", "de la que", "   ", "a y o"):
            response = self._search(query)
            self.assertEqual(response["terms"], [], query)
            self.assertEqual(self._mine(response), [], query)
        self.assertEqual(self._search("Revisar PR 979 estado")["terms"], ["revisar", "979", "estado"])

    def test_html_is_indexed_as_text(self):
        config = self._enable()
        record = self.env["res.partner"].create(
            {
                "name": "Nota",
                "comment": '<p>Revisar <span style="color:red">caldera</span><img src="data:image/png;base64,QUJD"/></p>',
            }
        )
        self._index(config)
        self.assertEqual(self._ids(self._search("caldera")), [record.id])
        self.assertNotIn(record.id, self._ids(self._search("span style color")))

    # ─── Fragment & matched terms come from the record, as the user reads it ──

    def test_snippet_and_terms_come_from_the_current_record_not_the_index(self):
        config = self._enable()
        self._index(config)
        # Edited by SQL, the way nothing updates write_date: the index still
        # says "Siemens", the record does not.
        self.env.cr.execute(
            "UPDATE res_partner SET comment = '<p>Se reemplazó por un equipo nuevo.</p>' WHERE id = %s",
            [self.both_terms.id],
        )
        self.both_terms.invalidate_recordset(["comment"])
        response = self._search("siemens trifásico", limit=50)
        record = next(r for r in response["records"] if r["id"] == self.both_terms.id)
        self.assertEqual(record["matched_terms"], [], "nothing the user can read contains the terms any more")
        self.assertNotIn("Siemens", record["snippet"])

    def test_domain_and_limit_are_applied(self):
        config = self._enable()
        self._index(config)
        response = self._search("motor", domain=[("id", "!=", self.one_term.id)], limit=50)
        self.assertNotIn(self.one_term.id, self._ids(response))
        self.assertIn(self.both_terms.id, self._ids(response))
        self.env["res.partner"].create([{"name": f"Motor lote {n}"} for n in range(60)])
        self._index(config)
        self.assertEqual(len(self._search("motor", limit=500)["records"]), search_module.MAX_LIMIT)
        self.assertEqual(
            len(self.env(user=self.user)["search.relevant"].search_relevant("res.partner", "motor")["records"]),
            search_module.DEFAULT_LIMIT,
        )
        self.assertEqual(len(self._search("motor", limit=3.0)["records"]), 3)

    def test_invalid_arguments_are_rejected(self):
        for args in (
            (None, "x"),
            ("res.partner", None),
            ("res.partner", "x", "not-a-domain"),
            ("res.partner", "x", [], "10"),
            ("res.partner", "x", [], 2.5),
        ):
            with self.assertRaises(ValidationError, msg=str(args)):
                self.env(user=self.user)["search.relevant"].search_relevant(*args)

    # ─── The indexed subset ──────────────────────────────────────────────

    def test_a_domain_indexes_only_the_records_that_match(self):
        """The case this was built for, on partners: part of a model, not all of it.

        The domain has to hold on both paths: the index and the records created
        after the cursor, which the search reads live.
        """
        inside = self.env["res.partner"].create({"name": "Repuesto berenjena", "ref": "search-indexed"})
        outside = self.env["res.partner"].create({"name": "Otra berenjena", "ref": "search-ignored"})
        config = self._enable("res.partner", ("name",))
        config.domain = "[('ref', '=', 'search-indexed')]"
        self._index(config)
        self.assertEqual(config.backfill_total, 1, "only what the domain allows is counted")
        self.assertEqual(self._indexed_ids(config), {inside.id})
        self.assertEqual(self._ids(self._search("berenjena")), [inside.id])

        # Leaving the domain is a write, and the freshness pass is where the
        # write shows up: the row goes with it.
        outside.ref = "search-indexed"
        inside.ref = "search-ignored"
        self._later_write_date(inside)
        self._later_write_date(outside)
        config._sync_batch(100)
        self.assertEqual(self._indexed_ids(config), {outside.id})
        self.assertEqual(self._ids(self._search("berenjena")), [outside.id])

        created = self.env["res.partner"].create({"name": "Nueva berenjena", "ref": "search-ignored"})
        self.assertGreater(created.id, config.sync_cursor, "precondition: read live")
        self.assertEqual(self._ids(self._search("berenjena")), [outside.id])

    def test_a_domain_that_changes_drops_what_it_leaves_out(self):
        """Nothing writes the records a new domain leaves out, so the next cron
        run purges their rows instead of waiting for the daily pass."""
        config = self._enable("res.partner", ("name",))
        self._index(config)
        self.assertIn(self.both_terms.id, self._indexed_ids(config))
        config.domain = f"[('id', '=', {self.one_term.id})]"
        self.assertFalse(config.last_purge_at, "the purge is due now, not tomorrow")
        self.assertTrue(config._purge_deleted() >= 1)
        self.assertNotIn(self.both_terms.id, self._indexed_ids(config))

    def test_a_domain_that_does_not_parse_or_does_not_apply_is_refused(self):
        config = self._enable("res.partner", ("name",))
        for domain in ("[('ref', '=', ", "{'ref': 'x'}", "[('no_such_field', '=', 1)]"):
            with self.assertRaises(ValidationError, msg=domain):
                config.domain = domain

    # ─── A model that only grows (the chatter) ───────────────────────────

    def test_freshness_by_id_indexes_what_was_added_and_keeps_the_domain(self):
        """``append_only``: the pass walks the primary key from ``sync_cursor``
        instead of scanning the whole table for what was written lately."""
        config = self._enable("res.partner", ("name",))
        config.write({"domain": "[('ref', '=', 'search-indexed')]", "append_only": True})
        self._index(config)
        self.assertTrue(config.sync_watermark, "the pass ran and left its mark")

        inside = self.env["res.partner"].create({"name": "Agregado membrillox", "ref": "search-indexed"})
        outside = self.env["res.partner"].create({"name": "Agregado membrillox afuera"})
        processed, more, _last = config._sync_batch(100)
        self.assertEqual((processed, more), (1, False), "only what the domain allows is indexed")
        self.assertEqual(self._indexed_ids(config), {inside.id})
        self.assertLess(config.sync_cursor, outside.id, "the cursor stays behind the ids this pass just walked")
        self.assertEqual(self._ids(self._search("membrillox")), [inside.id])

    def test_a_record_edited_after_being_indexed_keeps_its_indexed_text(self):
        """The price of ``append_only``, pinned: a record already indexed is
        never looked at again, so its old text keeps matching. What the user
        gets is still read from the record, so nothing stale is shown."""
        config = self._enable("res.partner", ("name",))
        config.append_only = True
        self._index(config)
        self.assertIn(self.one_term.id, self._ids(self._search("genérico")))

        self.one_term.name = "Compresor zarzamox"
        self._later_write_date(self.one_term)
        config._sync_batch(100)
        self.assertEqual(self._mine(self._search("zarzamox")), [], "the new text is not indexed")
        response = self._search("genérico")
        self.assertIn(self.one_term.id, self._ids(response), "the old text still matches")
        record = next(r for r in response["records"] if r["id"] == self.one_term.id)
        self.assertEqual(record["matched_terms"], [], "what comes out is read from the record")
        self.assertNotIn("genérico", record["snippet"])

    def test_a_deleted_record_is_not_returned_when_the_pass_goes_by_id(self):
        config = self._enable("res.partner", ("name",))
        config.append_only = True
        self._index(config)
        gone = self.env["res.partner"].create({"name": "Efímero zanahorix"})
        config._sync_batch(100)
        self.assertEqual(self._ids(self._search("zanahorix")), [gone.id])

        gone.unlink()
        self.assertEqual(self._mine(self._search("zanahorix")), [], "the user's own search drops deleted ids")
        self.assertEqual(config._purge_deleted(), 1)
        self.assertNotIn(gone.id, self._indexed_ids(config))

    def test_the_backfill_walks_bounded_windows_and_ends_when_the_domain_is_covered(self):
        """A selective domain must not make the backfill read the whole table:
        each step looks at a range of ids, and the walk ends as soon as what
        the domain counted is indexed, without reaching the first id."""
        inside = self.env["res.partner"].create([{"name": f"Ventanax {n}", "ref": "search-indexed"} for n in range(3)])
        self.env["res.partner"].create([{"name": f"Ventanax fuera {n}"} for n in range(3)])
        config = self._enable("res.partner", ("name",))
        config.domain = "[('ref', '=', 'search-indexed')]"
        self.assertFalse(config.backfill_total, "the click does not count the table")
        config._backfill_batch(2)
        self.assertEqual(config.backfill_total, 3)
        self.assertGreater(config._backfill_window(2), 2, "a sparse domain widens the window")

        steps = 1
        with patch.object(SearchRelevantConfig, "_backfill_window", lambda config, batch_size: 10):
            while config.backfill_cursor:
                steps += 1
                self.assertLess(steps, 5, "the walk went on past what the domain counted")
                config._backfill_batch(2)
        self.assertEqual(self._indexed_ids(config), set(inside.ids))
        self.assertEqual(config.backfill_done, 3)
        self.assertEqual(set(self._ids(self._search("ventanax"))), set(inside.ids))

    def test_a_record_that_enters_the_domain_does_not_end_the_backfill_early(self):
        """The count taken when the model was enabled is a lower bound: a record
        written *into* the ``domain`` while the backfill runs is one more record
        below the cursor. Stopping on that count left the oldest records
        unindexed and the coverage saying ``complete`` — nothing would have
        picked them up, because nobody writes them again."""
        Partner = self.env["res.partner"]
        oldest = Partner.create({"name": "Zqlejanox del fondo", "ref": "search-indexed"})
        latecomer = Partner.create({"name": "Zqlejanox tardio"})
        newer = Partner.create([{"name": f"Zqlejanox {n}", "ref": "search-indexed"} for n in range(3)])
        config = self._enable("res.partner", ("name",))
        config.domain = "[('ref', '=', 'search-indexed')]"
        config._backfill_batch(2)
        self.assertEqual(config.backfill_total, 4, "what the domain held when the model was enabled")

        # It matches the domain only now, and its id is below the cursor: from
        # here on there are five records to index, not the four that were counted.
        latecomer.ref = "search-indexed"
        while config.backfill_cursor:
            config._backfill_batch(2)

        self.assertEqual(self._indexed_ids(config), set(oldest.ids) | set(newer.ids) | set(latecomer.ids))
        response = self._search("zqlejanox")
        self.assertEqual(response["coverage"]["state"], "complete")
        self.assertIn(oldest.id, self._ids(response))

    def test_the_cursor_keeps_its_margin_in_time_not_in_ids(self):
        """An id is handed out when the row is written and shows up when its
        transaction commits, so a transaction that commits late lands below the
        cursor. A count of ids does not bound how far below — on a busy table a
        thousand ids are seconds — so the cursor only moves up to where a pass
        stood ``SYNC_ID_MARGIN`` ago. One cursor for both kinds of pass."""
        for append_only in (True, False):
            with self.subTest(append_only=append_only):
                config = self._enable("res.partner", ("name",))
                config.append_only = append_only
                self._index(config)
                start = config.sync_cursor
                self.assertTrue(start)

                recent = self.env["res.partner"].create({"name": f"Zqtardiox recien llegado {append_only}"})
                config._sync_batch(100)
                self.assertIn(recent.id, self._ids(self._search("zqtardiox")))
                self.assertEqual(config.sync_cursor, start, "the cursor does not follow the ids of this very pass")

                def age_the_last_promotion(config=config):
                    config.sync_reached_at = self.env.cr.now() - config_module.SYNC_ID_MARGIN - timedelta(minutes=1)

                age_the_last_promotion()
                config._sync_batch(100)
                self.assertGreaterEqual(config.sync_reached, recent.id, "this pass is what the next promotion moves to")
                self.assertEqual(config.sync_cursor, start, "and the cursor only takes a pass that old")

                age_the_last_promotion()
                config._sync_batch(100)
                self.assertGreaterEqual(config.sync_cursor, recent.id, "a pass that old has had time to commit")
                self.assertIn(recent.id, self._ids(self._search("zqtardiox")), "found in the index now")

    def test_a_configuration_with_an_index_is_archived_not_deleted(self):
        """``config_id`` cascades: deleting the configuration would drop every
        row of the model in one statement, inside the request of whoever clicked.
        Archiving hands that to the cron, in batches."""
        config = self._enable("res.partner", ("name",))
        self._index(config)
        self.assertTrue(config.document_count)
        with self.assertRaises(UserError):
            config.unlink()

        config.active = False
        while config._cleanup_batch(1000)[1]:
            pass
        config.unlink()
        self.assertFalse(config.exists())

    def test_the_answer_says_which_record_a_row_hangs_from(self):
        """A chatter message answers with its task, read as the user and only for
        the rows that passed the check; a model that points at nothing says
        nothing."""
        member, _portal, tasks, messages = self._chatter()
        config = self.Config.search([("model", "=", "mail.message")])
        self.assertEqual(config._parent_fields(), ("model", "res_id"))
        response, _found = self._chatter_ids(member, "zqcolectorax abierta")
        record = next(r for r in response["records"] if r["id"] == messages["open"].id)
        self.assertEqual((record["res_model"], record["res_id"]), ("project.task", tasks["open"].id))

        partners = self._enable()
        self.assertIsNone(partners._parent_fields())
        self._index(partners)
        record = next(r for r in self._search("bomba", limit=50)["records"] if r["id"] == self.both_terms.id)
        self.assertNotIn("res_model", record)

    # ─── Configuration & database footprint ──────────────────────────────

    def test_only_plain_stored_text_fields_can_be_enabled(self):
        with self.assertRaises(ValidationError):
            self._enable("res.partner", ("color",))  # an integer
        with self.assertRaises(ValidationError):
            self._enable("res.users", ("name",))  # delegated to res.partner through _inherits
        with self.assertRaises(ValidationError):
            self._enable("res.partner", ())
        with self.assertRaises(ValidationError):
            self._enable("base.language.export", ("name",))  # transient
        with self.assertRaises(ValidationError):
            self._enable("res.partner", ("name", "comment", "ref", "email", "website"))  # a weight per field, four

    def test_changing_the_fields_stops_the_old_ones_from_matching_at_once(self):
        config = self._enable()
        self._index(config)
        self.assertIn(self.both_terms.id, self._ids(self._search("trifásico")))
        config.field_ids = self.env["ir.model.fields"].search([("model", "=", "res.partner"), ("name", "=", "name")])
        response = self._search("trifásico")
        self.assertEqual(self._mine(response), [])
        self.assertEqual(response["coverage"]["state"], "partial")
        self._index(config)
        self.assertEqual(self._mine(self._search("trifásico")), [])
        self.assertIn(self.both_terms.id, self._ids(self._search("bomba")))

    def test_a_field_that_disappears_does_not_shift_the_others(self):
        """N5: a field removed by cascade (a deleted manual field, a module update)
        never passes through ``write``; the labels of the other fields must not
        move, its words must stop matching, and the model is re-indexed."""
        partner = self.env["res.partner"].create(
            {"name": "Cliente ciruela", "comment": "<p>kiwano</p>", "ref": "kumquat"}
        )
        config = self._enable(field_names=("name", "comment", "ref"))
        self._index(config)
        self.assertEqual(config.layout_fields, "name,comment,ref")
        admin = self.env.ref("base.user_admin")
        self.assertEqual(self._ids(self._search("kiwano", user=admin)), [partner.id])

        field_ids = config._fields["field_ids"]
        comment = self.env["ir.model.fields"]._get("res.partner", "comment")
        self.env.cr.execute(
            SQL(
                "DELETE FROM %s WHERE %s = %s AND %s = %s",
                SQL.identifier(field_ids.relation),
                SQL.identifier(field_ids.column1),
                config.id,
                SQL.identifier(field_ids.column2),
                comment.id,
            )
        )
        config.invalidate_recordset(["field_ids"])
        self.assertFalse(config._layout_intact())
        response = self._search("kiwano", user=admin)
        self.assertEqual(self._mine(response), [], "the disappeared field's words no longer match")
        self.assertEqual(response["coverage"]["state"], "partial")
        self.assertEqual(self._ids(self._search("kumquat", user=admin)), [partner.id], "ref keeps its own label")

        config._rebuild_outdated()
        self._index(config)
        self.assertTrue(config._layout_intact())
        self.assertEqual(self._mine(self._search("kiwano", user=admin)), [])
        response = self._search("kumquat", user=admin)
        self.assertEqual((response["coverage"]["state"], self._ids(response)), ("complete", [partner.id]))

    def test_an_index_built_by_another_rule_is_rebuilt_and_partial_meanwhile(self):
        config = self._enable()
        self._index(config)
        config.normalization = False  # as left by an earlier version of the module
        self.assertEqual(self._search("motor")["coverage"]["state"], "partial")
        old_layout = config.layout
        config._rebuild_outdated()  # what each cron run starts with
        self.assertEqual(config.normalization, search_module.NORMALIZATION_VERSION)
        self.assertEqual(config.layout, old_layout + 1)
        self.assertEqual(self._search("motor")["coverage"]["state"], "partial", "until the backfill is done")
        self._index(config)
        self.assertEqual(self._search("motor")["coverage"]["state"], "complete")

    def test_the_fragment_reads_only_the_fields_that_matched(self):
        """A long HTML field is not read for a record that matched by name."""
        record = self.env["res.partner"].create(
            {"name": "Lectura corta zapallox", "comment": "<p>" + "texto " * 5000 + "</p>"}
        )
        config = self._enable()
        self._index(config)
        partner_class = type(self.env["res.partner"])
        original = partner_class.read
        read_fields = []

        def spy(records, fields=None, load="_classic_read"):
            if record.id in records.ids:
                read_fields.append(set(fields or []))
            return original(records, fields, load)

        with patch.object(partner_class, "read", spy):
            response = self._search("zapallox")
        self.assertEqual(self._ids(response), [record.id])
        self.assertTrue(read_fields)
        self.assertTrue(all("comment" not in fields for fields in read_fields), read_fields)

    def test_nothing_is_installed_in_the_database_besides_the_table(self):
        """Regression: an extension created by the module broke ``pg_restore`` onto a
        database that has ``unaccent`` in ``public``. No extension, no text
        search configuration, no function — and ``ilike`` is untouched."""

        def footprint():
            self.env.cr.execute(
                """
                SELECT (SELECT array_agg(extname ORDER BY extname) FROM pg_extension),
                       (SELECT count(*) FROM pg_ts_config WHERE cfgname LIKE 'search_relevant%%'),
                       (SELECT count(*) FROM pg_proc WHERE proname LIKE 'search_relevant%%' OR proname = 'unaccent')
                """
            )
            return self.env.cr.fetchone(), has_unaccent(self.env.cr)

        before = footprint()
        config = self._enable()
        self._index(config)
        self._search("conciliación")
        self.assertEqual(footprint(), before)

    # ─── A business model, when installed ───────────────────────────────

    def test_project_task_description(self):
        if "project.task" not in self.env:
            self.skipTest("project is not installed")
        config = self._enable("project.task", ("name", "description"))
        project = self.env["project.project"].create({"name": "Relevance search project"})
        task = self.env["project.task"].create(
            {
                "name": "Ticket de soporte",
                "project_id": project.id,
                "description": "<p>El <b>variador</b> no arranca</p>",
            }
        )
        private = self.env["project.project"].create({"name": "Private", "privacy_visibility": "followers"})
        hidden = self.env["project.task"].create(
            {"name": "Tarea privada", "project_id": private.id, "description": "<p>variador secreto</p>"}
        )
        self._index(config)
        self.user.group_ids = [(4, self.env.ref("project.group_project_user").id)]
        ids = self._ids(self._search("variador", model="project.task"))
        self.assertIn(task.id, ids)
        self.assertNotIn(hidden.id, ids)

    def test_project_task_friolandia(self):
        """The real case, on tasks: "task" and "project" name the kind of record
        (the model and the project_id of the search view), so they weigh least."""
        if "project.task" not in self.env:
            self.skipTest("project is not installed")
        self.assertTrue({"task", "project"} <= self.env["search.relevant"]._type_terms("project.task", "en_US"))
        project = self.env["project.project"].create({"name": "Relevance search project"})
        target = self.env["project.task"].create({"name": "Gap Analisis - Friolandia", "project_id": project.id})
        self.env["project.task"].create(
            [{"name": f"Task for the project gap {n}", "project_id": project.id} for n in range(3)]
        )
        config = self._enable("project.task", ("name", "description"))
        self._index(config)
        self.user.group_ids = [(4, self.env.ref("project.group_project_user").id)]
        response = self._search("the task of gap analysis of the project Friolandia", model="project.task")
        self.assertEqual(self._ids(response)[0], target.id)
