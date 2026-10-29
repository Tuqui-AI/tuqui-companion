from odoo import fields, models
from odoo.tools.sql import column_exists, create_column, create_index


class SearchRelevantDocument(models.Model):
    """One row of the relevance index: the searchable text of one record.

    A table of its own, not a generated column on the indexed model: adding one
    rewrites the whole table under ``ACCESS EXCLUSIVE``, and enabling a model
    must leave no mark on tables other modules own. An expression index still
    locks writes while it builds and cannot hold cleaned HTML. The price: the
    text is stored twice, and the cron keeps it fresh.

    **Nobody reads this model through the ORM.** No access grants it, even to
    an administrator without ``sudo``: the text was extracted
    without record rules. It reaches a user only through
    ``search.relevant.search_relevant``, which checks ids with the user's
    ``search`` and builds fragments from the user's ``read``.
    """

    _name = "search.relevant.document"
    _description = "Relevance Search Index Entry"
    # Millions of rows: the four audit columns would be pure weight.
    _log_access = False
    _rec_name = "res_id"

    config_id = fields.Many2one(
        "search.relevant.config",
        required=True,
        readonly=True,
        # Deleting a configuration drops its rows in the same statement.
        ondelete="cascade",
    )
    res_id = fields.Integer(required=True, readonly=True)
    layout = fields.Integer(
        readonly=True,
        help="Field layout and normalization this row was built with (search.relevant.config.layout).",
    )
    source_write_date = fields.Datetime(
        readonly=True,
        help="write_date of the source record when it was indexed. The cron compares it to skip unchanged records.",
    )
    indexed_at = fields.Datetime(readonly=True)

    # Also the arbiter of the upserts (ON CONFLICT (config_id, res_id)) and the
    # index every lookup by record uses.
    _config_res_unique = models.Constraint(
        "UNIQUE (config_id, res_id)",
        "A record can only be indexed once per enabled model.",
    )

    def init(self):
        """Add the ``tsvector`` column and its GIN index (the ORM has no such field type).

        Created on install, with the table empty; later updates are a no-op that
        takes no lock.
        """
        cr = self.env.cr
        if not column_exists(cr, self._table, "tsv"):
            create_column(cr, self._table, "tsv", "tsvector")
        create_index(cr, f"{self._table}_tsv_gin", self._table, ['"tsv"'], method="gin")
