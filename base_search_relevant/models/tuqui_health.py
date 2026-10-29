from odoo import api, models


class TuquiHealth(models.AbstractModel):
    _inherit = "tuqui.health"

    @api.model
    def _capabilities(self):
        # tuqui.search.search_relevant: ranked search over the models an admin
        # enabled. Whether a given model is searchable is answered per call
        # (coverage.state), so the capability says only that the engine is here.
        # search_relevant.chatter: tuqui.search takes options={"chatter": True}
        # and answers with via; whether a model's chatter is indexed is again
        # answered per call (coverage.chatter).
        return super()._capabilities() + ["search_relevant", "search_relevant.chatter"]
