"""Model names a caller asked for that do not exist, and what each one meant.

``GUESSES`` mixes two sources. One family is real: names that production asked
for and got ``Unknown model`` back. The rest are guesses over standard models,
one family per thing the ranker has to get right — a typo, a dot where the model
has an underscore, a name built around the one word that matters, a model of an
older version. ``REGISTRY`` is the COMPLETE registry they are scored against: a
suggestion is only as good as the wrong answers it beat.

Keep the registry whole. Word weights are ``1.0 / occurrences``, so trimming it
inflates every weight while ``_MODEL_MIN_SEGMENTS`` stays absolute, and the
suite gets easier without anything getting better.

Expected value per guess:
    str  — that model must come back first
    set  — any of those is defensible; the guess is genuinely ambiguous
    None — nothing may come back: every candidate would point somewhere else
"""

from odoo.addons.tuqui.tests.model_guess_registry import MODELS

# Assigned rather than re-exported straight from the import: the name is what
# this file means by it — the pool every guess gets scored against.
REGISTRY = MODELS

GUESSES = {
    # ── Asked for in production.
    "crm.lead.tag": "crm.tag",
    "helpdesk.ticket.tag": "helpdesk.tag",
    "stock.orderpoint": "stock.warehouse.orderpoint",
    "hr.contract": "hr.contract.type",
    "hr.expense.sheet": "hr.expense",
    "stock.valuation.layer": "stock_account.stock.valuation.report",
    "sale.subscription": {"sale.subscription.plan", "sale.subscription.report"},
    "product.replenishment.cost": "product.replenish",
    "account.payment.group": {"account.payment", "account.group"},
    "queue.job": None,
    "ir.property": None,
    "product.product_catalog_report": None,
    "report.aeroo.report": None,
    "school.school": None,
    "alerta": None,
    # ── A typo that shares no whole word with the model.
    "crm.leed": "crm.lead",
    "saleorder": "sale.order",
    "acount.move": "account.move",
    "res.parnter": "res.partner",
    "product.templat": "product.template",
    "helpdesk.tickets": "helpdesk.ticket",
    "project.tasks": "project.task",
    "website.pages": "website.page",
    "account.moves": {"account.move", "account.move.line"},
    # ── A dot where the model has an underscore.
    "ir.config.parameter": "ir.config_parameter",
    "config.parameter": "ir.config_parameter",
    "ir.mail.server": "ir.mail_server",
    "ir.sequence.date.range": "ir.sequence.date_range",
    "survey.user.input": "survey.user_input",
    "hr.payslip.worked.days": "hr.payslip.worked_days",
    # ── The word that names the thing, with the wrong words around it.
    "sale.line": "sale.order.line",
    "purchase.line": "purchase.order.line",
    "partner.bank": "res.partner.bank",
    "stock.lot.serial": "stock.lot",
    "calendar.meeting": "calendar.event",
    "mail.activities": "mail.activity",
    "res.partner.category.tag": "res.partner.category",
    "order.line": {"sale.order.line", "purchase.order.line", "pos.order.line"},
    # ── The name a model had in an older version.
    "stock.production.lot": "stock.lot",
    "account.invoice": "account.move",
    "account.invoice.line": "account.move.line",
    "hr.holidays": "hr.leave",
    # ── Nothing to offer. Saying so is the answer.
    "library.book": None,
}

# The 12 the ranker gets wrong over this registry — 31/43. Listed so a
# regression elsewhere cannot hide inside the pass rate: shrinking this set is
# the point, growing it fails the suite. Four failure shapes:
#
#   Answers instead of staying silent — `ir.property` → `ir.exports`,
#   `queue.job` → `voip.queue.mixin`, `product.product_catalog_report` →
#   `product.catalog.mixin`. Each shares one word that clears the floor, and
#   nothing says "different thing entirely".
#
#   ONE RARE WORD OUTVOTES SEVERAL COMMON ONES. `hr.expense.sheet` matches two
#   of three words in `hr.expense`, but `sheet` is rare enough that
#   `account.balance.sheet.report.handler` — one word of three — scores higher.
#   Same for `product.replenishment.cost` and `account.payment.group`.
#
#   `crm.lead.tag` → `crm.tag` and `helpdesk.ticket.tag` → `helpdesk.tag` are
#   the same thing seen from the other side: `tag` is the word that names what
#   the caller wanted, and it is too common to win.
#
#   A model renamed between versions shares no word with its new name:
#   `account.invoice` is `account.move` and `hr.holidays` is `hr.leave`. Only a
#   table of renames would answer these; the ranker cannot.
KNOWN_MISSES = frozenset(
    {
        # answers where silence was right
        "ir.property",
        "queue.job",
        "product.product_catalog_report",
        "report.aeroo.report",
        # one rare word beat several matching ones
        "hr.expense.sheet",
        "product.replenishment.cost",
        "account.payment.group",
        # the naming word was too common to win
        "crm.lead.tag",
        "helpdesk.ticket.tag",
        # renamed in a later version
        "account.invoice",
        "account.invoice.line",
        "hr.holidays",
    }
)


def verdict(guess, suggestions):
    """True when ``suggestions`` answers ``guess`` acceptably."""
    expected = GUESSES[guess]
    head = suggestions[0] if suggestions else None
    if expected is None:
        return head is None
    if isinstance(expected, set):
        return head in expected
    return head == expected
