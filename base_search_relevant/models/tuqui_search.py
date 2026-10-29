from odoo import api, models

from .search_relevant import DEFAULT_LIMIT


class TuquiSearch(models.AbstractModel):
    """The RPC entry point Tuqui calls, over this module's engine.

    The Tuqui backend calls ``tuqui.search.search_relevant`` by ``execute_kw``:
    neither the model name nor the shape of the answer can change on one side
    only. Not in ``tuqui``, which ships to every client: a backend calls it only
    when ``/tuqui/health`` advertises ``search_relevant``.

    The name starts with ``search`` so the ``/tuqui/rpc`` gate classifies it as
    a read: it must never write.
    """

    _name = "tuqui.search"
    _description = "Tuqui Relevance Search"

    @api.model
    @api.readonly
    def search_relevant(self, model, query, domain=None, limit=DEFAULT_LIMIT, options=None):
        """Records of ``model`` that best match ``query``, as the current user sees them.

        Order, permissions and coverage: see
        :meth:`~odoo.addons.base_search_relevant.models.search_relevant.SearchRelevant.search_relevant`.

        :param dict options: ``{"chatter": True}`` merges the messages of each
            record into its search, and a record found through one carries
            ``via``. Off unless asked: a backend that does not know ``via``
            would get records whose fields do not hold the words. The backend
            asks when ``/tuqui/health`` advertises ``search_relevant.chatter``.
        :returns: ``{"engine", "terms", "term_stats", "population", "coverage":
            {"state", "indexed_until", "fields", "chatter"}, "records": [{"id",
            "score", "matched_terms", "snippet"}]}``, with ``via`` on a record
            found through a message, and ``res_model`` and ``res_id`` on each
            record of a model that points at another one, like a chatter
            message at its task; ``coverage.state`` is ``not_enabled`` (and
            ``records`` empty) when no administrator enabled ``model`` — a
            signal to use another engine, not an error.
        """
        options = options if isinstance(options, dict) else {}
        # Same env: the engine runs as the caller, with the caller's language
        # (it decides which words only name the kind of record).
        return self.env["search.relevant"].search_relevant(
            model, query, domain=domain, limit=limit, chatter=bool(options.get("chatter"))
        )
