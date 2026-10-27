"""The whole model registry of one stock Odoo, for calibrating the suggester.

Generated from Odoo 19 Community and Enterprise with only standard apps
installed (1157 models), with:

    odoo_search_read('ir.model', [], fields=['model'], order='model asc')

Kept WHOLE on purpose. Word weights are ``1.0 / occurrences``, so trimming the
registry inflates every weight while ``_MODEL_MIN_SEGMENTS`` is an absolute
floor: a hand-picked list of "the ones that could compete" once made the corpus
pass cases that the complete registry answered wrong. Whatever replaces this
file has to be a complete registry too.

Not a snapshot to keep in sync: it is a fixed reference point. Regenerate only
to calibrate against a different Odoo, and re-run the corpus when you do.
"""

MODELS = """
_unknown account.account account.account.fiscal.rate account.account.tag
account.accrued.orders.wizard account.aged.partner.balance.report.handler
account.aged.payable.report.handler account.aged.receivable.report.handler
account.analytic.account account.analytic.applicability
account.analytic.distribution.model account.analytic.line
account.analytic.line.calendar.employee account.analytic.plan
account.audit.account.status account.auto.reconcile.wizard
account.automatic.entry.wizard account.autopost.bills.wizard
account.balance.sheet.report.handler account.bank.reconciliation.report.handler
account.bank.selection account.bank.statement account.bank.statement.line
account.bank.statement.line.transient account.cash.flow.report.handler
account.cash.rounding account.change.lock.date account.chart.template
account.code.mapping account.customer.statement.report.handler
account.deferred.expense.report.handler account.deferred.report.handler
account.deferred.revenue.report.handler account.document.import.mixin
account.duplicate.transaction.wizard account.ec.sales.report.handler
account.edi.cii account.edi.common account.edi.ubl account.edi.ubl_cen_en16931
account.edi.ubl_pint account.edi.ubl_pint_eu account.edi.xml.cii
account.edi.xml.ubl_20 account.edi.xml.ubl_21 account.edi.xml.ubl_a_nz
account.edi.xml.ubl_bis3 account.edi.xml.ubl_de account.edi.xml.ubl_efff
account.edi.xml.ubl_nl account.edi.xml.ubl_sg account.financial.year.op
account.fiscal.categories.fleet.report.handler account.fiscal.category
account.fiscal.position account.fiscal.position.account
account.fiscal.report.handler account.fiscal.year account.followup.report
account.followup.report.handler account.full.reconcile
account.general.ledger.report.handler account.generic.tax.report.handler
account.generic.tax.report.handler.account.tax
account.generic.tax.report.handler.tax.account account.group account.incoterms
account.invoice.report account.journal account.journal.group
account.journal.report.handler account.lock_exception account.merge.wizard
account.merge.wizard.line account.missing.transaction.wizard account.move
account.move.line account.move.reversal account.move.send
account.move.send.batch.wizard account.move.send.wizard
account.multicurrency.revaluation.report.handler
account.multicurrency.revaluation.wizard account.online.account
account.online.link account.partial.reconcile
account.partner.ledger.report.handler account.payment account.payment.method
account.payment.method.line account.payment.register account.payment.term
account.payment.term.line account.reconcile.model account.reconcile.model.line
account.reconcile.wizard account.report account.report.annotation
account.report.budget account.report.budget.item account.report.column
account.report.custom.handler account.report.expression
account.report.external.value account.report.file.download.error.wizard
account.report.horizontal.group account.report.horizontal.group.rule
account.report.line account.report.send account.resequence.wizard account.return
account.return.check account.return.check.template
account.return.creation.wizard account.return.payment.wizard
account.return.submission.wizard account.return.type account.root
account.secure.entries.wizard account.setup.bank.manual.config account.tax
account.tax.group account.tax.repartition.line account.tax.report.handler
account.tax.unit account.trial.balance.report.handler
account_followup.followup.line account_followup.manual_reminder
account_followup.missing.information.wizard account_reports.export.wizard
account_reports.export.wizard.format add.iot.box ai.agent ai.agent.source
ai.composer ai.embedding ai.prompt.button ai.topic ai_documents.sort
analytic.mixin analytic.plan.fields.mixin applicant.get.refuse.reason
applicant.send.mail appointment.answer appointment.answer.input
appointment.booking.line appointment.invite appointment.manage.leaves
appointment.question appointment.resource appointment.slot appointment.type
appraisal.ask.feedback appraisal.select.survey approval.approver
approval.category approval.category.approver approval.product.line
approval.request auth.passkey.key auth.passkey.key.create
auth.totp.rate.limit.log auth_totp.device auth_totp.wizard auto.config.pos.iot
avatar.mixin barcode.nomenclature barcode.rule barcodes.barcode_events_mixin
base base.automation base.document.layout base.enable.profiling.wizard
base.geo_provider base.geocoder base.import.module base.language.export
base.language.import base.language.install base.module.install.request
base.module.install.review base.module.uninstall base.module.update
base.module.upgrade base.partner.merge.automatic.wizard base.partner.merge.line
base_import.import base_import.mapping bill.to.po.wizard blog.blog blog.post
blog.tag blog.tag.category bus.bus bus.listener.mixin calendar.alarm
calendar.alarm_manager calendar.attendee calendar.booking calendar.booking.line
calendar.event calendar.event.type calendar.filters
calendar.popover.delete.wizard calendar.provider.config calendar.recurrence
certificate.certificate certificate.key change.password.own change.password.user
change.password.wizard change.production.qty chatbot.message chatbot.script
chatbot.script.answer chatbot.script.step choose.delivery.carrier
confirm.stock.sms coupon.share crm.activity.report crm.iap.lead.helpers
crm.iap.lead.industry crm.iap.lead.mining.request crm.iap.lead.role
crm.iap.lead.seniority crm.lead crm.lead.convert2ticket crm.lead.lost
crm.lead.pls.update crm.lead.rental crm.lead.scoring.frequency
crm.lead.scoring.frequency.field crm.lead2opportunity.partner
crm.lead2opportunity.partner.mass crm.lost.reason crm.merge.opportunity
crm.quotation.partner crm.recurring.plan crm.stage crm.tag crm.team
crm.team.member data_cleaning.model data_cleaning.record data_cleaning.rule
data_merge.group data_merge.model data_merge.record data_merge.rule
data_recycle.model data_recycle.record decimal.precision delivery.carrier
delivery.price.rule delivery.zip.prefix digest.digest digest.tip
discuss.call.history discuss.channel discuss.channel.member
discuss.channel.rtc.session discuss.gif.favorite discuss.voice.metadata
documents.access documents.access.tracking documents.account.folder.setting
documents.document documents.link_to_record_wizard documents.mixin
documents.operation documents.redirect documents.request_wizard
documents.sharing documents.sharing.access documents.tag documents.unlink.mixin
edit.billable.time.target event.event event.event.configurator
event.event.ticket event.lead.request event.lead.rule event.mail
event.mail.registration event.mail.slot event.question event.question.answer
event.registration event.registration.answer event.sale.report event.slot
event.stage event.tag event.tag.category event.type event.type.mail
event.type.ticket expense.sample.receipt extract.mixin extract.mixin.with.words
fetchmail.server fleet.disallowed.expenses.rate fleet.service.type fleet.vehicle
fleet.vehicle.assignation.log fleet.vehicle.cost.report
fleet.vehicle.log.contract fleet.vehicle.log.services fleet.vehicle.model
fleet.vehicle.model.brand fleet.vehicle.model.category fleet.vehicle.odometer
fleet.vehicle.odometer.report fleet.vehicle.send.mail fleet.vehicle.state
fleet.vehicle.tag format.address.mixin format.vat.label.mixin forum.forum
forum.post forum.post.reason forum.post.vote forum.tag frontdesk.drink
frontdesk.frontdesk frontdesk.visitor fsm.stock.tracking fsm.stock.tracking.line
gamification.badge gamification.badge.user gamification.badge.user.wizard
gamification.challenge gamification.challenge.line gamification.goal
gamification.goal.definition gamification.goal.wizard gamification.karma.rank
gamification.karma.tracking google.gmail.mixin helpdesk.create.fsm.task
helpdesk.sla helpdesk.sla.report.analysis helpdesk.sla.status helpdesk.stage
helpdesk.stage.delete.wizard helpdesk.tag helpdesk.tag.assignment helpdesk.team
helpdesk.ticket helpdesk.ticket.convert.wizard helpdesk.ticket.report.analysis
helpdesk.ticket.select.forum.wizard helpdesk.ticket.to.lead
homework.location.wizard hr.applicant hr.applicant.category
hr.applicant.refuse.reason hr.applicant.skill hr.appraisal
hr.appraisal.campaign.wizard hr.appraisal.goal hr.appraisal.goal.skill
hr.appraisal.goal.tag hr.appraisal.note hr.appraisal.skill
hr.appraisal.skill.report hr.appraisal.template hr.attendance
hr.attendance.overtime.line hr.attendance.overtime.rule
hr.attendance.overtime.ruleset hr.bank.account.allocation.wizard
hr.bank.account.allocation.wizard.line hr.contract.sign.document.wizard
hr.contract.type hr.department hr.departure.reason hr.departure.wizard
hr.employee hr.employee.category hr.employee.certification.report
hr.employee.cv.wizard hr.employee.delete.wizard hr.employee.location
hr.employee.public hr.employee.skill hr.employee.skill.history.report
hr.employee.skill.report hr.expense hr.expense.approve.duplicate
hr.expense.post.wizard hr.expense.refuse.wizard hr.expense.split
hr.expense.split.wizard hr.holidays.cancel.leave hr.holidays.summary.employee
hr.individual.skill.mixin hr.job hr.job.platform hr.job.skill hr.leave
hr.leave.accrual.level hr.leave.accrual.plan hr.leave.allocation
hr.leave.allocation.generate.multi.wizard hr.leave.attendance.report
hr.leave.employee.type.report hr.leave.generate.multi.wizard
hr.leave.mandatory.day hr.leave.report hr.leave.report.calendar hr.leave.type
hr.manager.department.report hr.mixin hr.payroll.dashboard.warning
hr.payroll.declaration.mixin hr.payroll.edit.payslip.line
hr.payroll.edit.payslip.lines.wizard hr.payroll.edit.payslip.worked.days.line
hr.payroll.employee.declaration hr.payroll.headcount hr.payroll.headcount.line
hr.payroll.headcount.working.rate hr.payroll.index hr.payroll.note
hr.payroll.payment.report.wizard hr.payroll.structure hr.payroll.structure.type
hr.payslip hr.payslip.correction.wizard hr.payslip.input hr.payslip.input.type
hr.payslip.line hr.payslip.run hr.payslip.worked_days hr.recruitment.degree
hr.recruitment.report hr.recruitment.sign.document.wizard hr.recruitment.source
hr.recruitment.stage hr.recruitment.stage.report hr.referral.alert
hr.referral.alert.mail.wizard hr.referral.campaign.wizard hr.referral.friend
hr.referral.level hr.referral.link.to.share hr.referral.onboarding
hr.referral.points hr.referral.report hr.referral.reward
hr.referral.reward.report hr.referral.send.mail hr.referral.send.sms
hr.resume.line hr.resume.line.type hr.rule.parameter hr.rule.parameter.value
hr.salary.attachment hr.salary.rule hr.salary.rule.category
hr.salary.rule.section hr.skill hr.skill.level hr.skill.type hr.talent.pool
hr.timesheet.attendance.report hr.timesheet.stop.timer.confirmation.wizard
hr.timesheet.tip hr.user.work.entry.employee hr.version hr.version.wizard
hr.work.entry hr.work.entry.export.employee.mixin hr.work.entry.export.mixin
hr.work.entry.regeneration.wizard hr.work.entry.report hr.work.entry.type
hr.work.location hr_timesheet.merge.wizard html.field.history.mixin
html_editor.converter.test html_editor.converter.test.sub iap.account
iap.autocomplete.api iap.enrich.api iap.service im_livechat.channel
im_livechat.channel.member.history im_livechat.channel.rule
im_livechat.conversation.tag im_livechat.expertise im_livechat.report.channel
image.mixin iot.box iot.channel iot.device iot.discovered.box
iot.keyboard.layout iot.trigger ir.actions.act_url ir.actions.act_window
ir.actions.act_window.view ir.actions.act_window_close ir.actions.actions
ir.actions.client ir.actions.report ir.actions.server ir.actions.server.history
ir.actions.todo ir.asset ir.attachment ir.attachment.report ir.autovacuum
ir.binary ir.config_parameter ir.cron ir.cron.progress ir.cron.trigger
ir.default ir.demo ir.demo_failure ir.demo_failure.wizard ir.embedded.actions
ir.exports ir.exports.line ir.fields.converter ir.filters ir.http ir.logging
ir.mail_server ir.model ir.model.access ir.model.constraint ir.model.data
ir.model.fields ir.model.fields.selection ir.model.inherit ir.model.relation
ir.module.category ir.module.module ir.module.module.dependency
ir.module.module.exclusion ir.profile ir.qweb ir.qweb.field
ir.qweb.field.barcode ir.qweb.field.contact ir.qweb.field.date
ir.qweb.field.datetime ir.qweb.field.duration ir.qweb.field.float
ir.qweb.field.float_time ir.qweb.field.html ir.qweb.field.image
ir.qweb.field.image_url ir.qweb.field.integer ir.qweb.field.many2many
ir.qweb.field.many2one ir.qweb.field.monetary ir.qweb.field.one2many
ir.qweb.field.qweb ir.qweb.field.relative ir.qweb.field.selection
ir.qweb.field.text ir.qweb.field.time ir.rule ir.sequence ir.sequence.date_range
ir.ui.menu ir.ui.view ir.ui.view.custom ir.websocket
ir_actions_account_report_download job.add.applicants knowledge.article
knowledge.article.favorite knowledge.article.member knowledge.article.stage
knowledge.article.template.category knowledge.article.thread knowledge.cover
knowledge.invite kpi.provider l10n.us.940 l10n.us.941 l10n.us.w2
l10n.us.worker.compensation l10n_us.1099_box l10n_us_1099.wizard link.tracker
link.tracker.click link.tracker.code lot.label.layout loyalty.card
loyalty.card.update.balance loyalty.generate.wizard loyalty.history loyalty.mail
loyalty.program loyalty.reward loyalty.rule lunch.alert lunch.cashmove
lunch.cashmove.report lunch.location lunch.order lunch.product
lunch.product.category lunch.supplier lunch.topping mail.activity
mail.activity.mixin mail.activity.plan mail.activity.plan.template
mail.activity.schedule mail.activity.schedule.line mail.activity.todo.create
mail.activity.type mail.alias mail.alias.domain mail.alias.mixin
mail.alias.mixin.optional mail.blacklist mail.blacklist.remove mail.bot
mail.canned.response mail.compose.message mail.composer.mixin mail.followers
mail.followers.edit mail.gateway.allowed mail.guest mail.ice.server
mail.link.preview mail.mail mail.message mail.message.link.preview
mail.message.reaction mail.message.schedule mail.message.subtype
mail.message.translation mail.notification mail.presence mail.push
mail.push.device mail.render.mixin mail.scheduled.message mail.template
mail.template.preview mail.template.reset mail.thread mail.thread.blacklist
mail.thread.cc mail.thread.main.attachment mail.thread.phone
mail.tracking.duration.mixin mail.tracking.value mailing.contact
mailing.contact.import mailing.contact.to.list mailing.filter mailing.list
mailing.list.merge mailing.mailing mailing.mailing.schedule.date
mailing.mailing.test mailing.subscription mailing.subscription.optout
mailing.trace mailing.trace.report maintenance.equipment
maintenance.equipment.category maintenance.mixin maintenance.request
maintenance.stage maintenance.team marketing.activity marketing.campaign
marketing.campaign.test marketing.participant marketing.trace
microsoft.outlook.mixin mrp.account.wip.accounting
mrp.account.wip.accounting.line mrp.bom mrp.bom.byproduct mrp.bom.line
mrp.consumption.warning mrp.consumption.warning.line mrp.eco mrp.eco.approval
mrp.eco.approval.template mrp.eco.bom.change mrp.eco.routing.change
mrp.eco.stage mrp.eco.tag mrp.eco.type mrp.production mrp.production.backorder
mrp.production.backorder.line mrp.production.group mrp.production.serials
mrp.production.split mrp.production.split.line mrp.production.split.multi
mrp.report mrp.routing.workcenter mrp.unbuild mrp.workcenter
mrp.workcenter.capacity mrp.workcenter.productivity
mrp.workcenter.productivity.loss mrp.workcenter.productivity.loss.type
mrp.workcenter.tag mrp.workorder mrp_production.additional.workorder
onboarding.onboarding onboarding.onboarding.step onboarding.progress
onboarding.progress.step payment.capture.wizard payment.link.wizard
payment.method payment.provider payment.refund.wizard payment.token
payment.transaction phone.blacklist phone.blacklist.remove picking.label.type
planning.analysis.report planning.attendance.analysis.report
planning.calendar.resource planning.planning planning.preview
planning.recurrency planning.role planning.send planning.slot
planning.slot.template portal.mixin portal.share portal.wizard
portal.wizard.user pos.bill pos.bus.mixin pos.category pos.close.session.wizard
pos.config pos.confirmation.wizard pos.daily.sales.reports.wizard
pos.details.wizard pos.load.mixin pos.make.invoice pos.make.payment pos.note
pos.order pos.order.line pos.pack.operation.lot pos.payment pos.payment.method
pos.prep.display pos.prep.line pos.prep.order pos.prep.stage pos.prep.state
pos.preparation.display.reset.wizard pos.preset pos.printer pos.session
preparation.time.report privacy.log privacy.lookup.wizard
privacy.lookup.wizard.line product.attribute product.attribute.category
product.attribute.custom.value product.attribute.value product.catalog.mixin
product.category product.combo product.combo.item product.document product.feed
product.fetch.image.wizard product.image product.label.layout product.pricelist
product.pricelist.item product.pricing product.product product.public.category
product.removal product.replenish product.ribbon product.supplierinfo
product.tag product.template product.template.attribute.exclusion
product.template.attribute.line product.template.attribute.value product.uom
product.value product.wishlist project.collaborator project.milestone
project.project project.project.stage project.project.stage.delete.wizard
project.role project.sale.line.employee.map project.share.collaborator.wizard
project.share.wizard project.tags project.task
project.task.burndown.chart.report project.task.convert.wizard
project.task.recurrence project.task.stage.personal
project.task.stop.timers.wizard project.task.stop.timers.wizard.line
project.task.type project.task.type.delete.wizard project.template.create.wizard
project.template.role.to.users.map project.update properties.base.definition
properties.base.definition.mixin propose.change publisher_warranty.contract
purchase.bill.line.match purchase.bill.union purchase.edi.xml.ubl_bis3
purchase.order purchase.order.line purchase.report qr.code.payment.wizard
quality.alert quality.alert.stage quality.alert.team quality.check
quality.check.spreadsheet quality.check.wizard quality.point
quality.point.test_type quality.reason quality.spreadsheet.template quality.tag
quotation.document rating.mixin rating.parent.mixin rating.rating
registration.editor registration.editor.line rental.order.wizard
rental.order.wizard.line repair.order repair.tags
report.account.report_hash_integrity report.account.report_invoice
report.account.report_invoice_with_payments report.base.report_irmodulereference
report.event_iot.event_registration_badge_printer_report
report.hr_holidays.report_holidayssummary
report.hr_payroll.contribution_register report.hr_skills.report_employee_cv
report.industry_fsm.worksheet_custom report.layout
report.mrp.report_bom_structure report.mrp.report_mo_overview report.paperformat
report.point_of_sale.report_invoice report.point_of_sale.report_saledetails
report.pos.order report.pos_hr.single_employee_sales_report
report.product.report_pricelist report.product.report_producttemplatelabel2x7
report.product.report_producttemplatelabel4x12
report.product.report_producttemplatelabel4x12noprice
report.product.report_producttemplatelabel4x7
report.product.report_producttemplatelabel_dymo report.project.task.user
report.project.task.user.fsm report.quality_control.quality_worksheet
report.quality_control.quality_worksheet_internal
report.sign.green_savings_report report.stock.label_lot_template_view
report.stock.label_product_product_view report.stock.quantity
report.stock.report_reception report.stock.report_stock_rule request.appraisal
res.bank res.city res.company res.config res.config.settings res.country
res.country.group res.country.state res.currency res.currency.rate res.device
res.device.log res.groups res.groups.privilege res.lang res.partner
res.partner.bank res.partner.category res.partner.industry res.role res.users
res.users.apikeys res.users.apikeys.description res.users.apikeys.show
res.users.deletion res.users.identitycheck res.users.log res.users.settings
res.users.settings.embedded.action res.users.settings.volumes
reset.view.arch.wizard resource.calendar resource.calendar.attendance
resource.calendar.leaves resource.mixin resource.resource room.booking
room.office room.room sale.advance.payment.inv sale.edi.xml.ubl_bis3
sale.loyalty.coupon.wizard sale.loyalty.reward.wizard sale.mass.cancel.orders
sale.order sale.order.close.reason sale.order.coupon.points sale.order.discount
sale.order.line sale.order.log sale.order.log.report sale.order.spreadsheet
sale.order.template sale.order.template.line sale.pdf.form.field
sale.rental.report sale.report sale.subscription.change.customer.wizard
sale.subscription.close.reason.wizard sale.subscription.plan
sale.subscription.report sale.temporal.recurrence save.spreadsheet.template
select.printers.wizard sequence.mixin server.action.history.wizard
sign.completed.document sign.document sign.import.documents sign.item
sign.item.option sign.item.radio.set sign.item.role sign.item.type sign.log
sign.request sign.request.item sign.request.item.value sign.request.share
sign.send.request sign.send.request.signer sign.template sign.template.preview
sign.template.tag slide.answer slide.channel slide.channel.invite
slide.channel.partner slide.channel.tag slide.channel.tag.group slide.embed
slide.question slide.slide slide.slide.partner slide.slide.resource slide.tag
sms.account.code sms.account.phone sms.account.sender sms.composer sms.sms
sms.template sms.template.preview sms.template.reset sms.tracker
snailmail.letter social.account social.account.revoke.youtube social.live.post
social.media social.post social.post.template social.post.to.lead social.stream
social.stream.post social.stream.post.image social.stream.type
social.twitter.account spreadsheet.cell.thread spreadsheet.contributor
spreadsheet.dashboard spreadsheet.dashboard.group spreadsheet.dashboard.share
spreadsheet.document.to.dashboard spreadsheet.mixin spreadsheet.revision
spreadsheet.template stock.avco.report stock.backorder.confirmation
stock.backorder.confirmation.line stock.forecasted_product_product
stock.forecasted_product_template stock.inventory.adjustment.name
stock.inventory.conflict stock.inventory.warning stock.location stock.lot
stock.move stock.move.line stock.orderpoint.snooze stock.package
stock.package.destination stock.package.history stock.package.type stock.picking
stock.picking.type stock.put.in.pack stock.putaway.rule stock.quant
stock.quant.relocate stock.quantity.history stock.reference
stock.replenish.mixin stock.replenishment.info stock.replenishment.option
stock.report stock.request.count stock.return.picking stock.return.picking.line
stock.route stock.rule stock.rules.report stock.scrap stock.scrap.reason.tag
stock.storage.category stock.storage.category.capacity stock.traceability.report
stock.warehouse stock.warehouse.orderpoint stock.warn.insufficient.qty
stock.warn.insufficient.qty.repair stock.warn.insufficient.qty.scrap
stock.warn.insufficient.qty.unbuild stock_account.stock.valuation.report
stock_barcode.cancel.operation studio.approval.entry studio.approval.request
studio.approval.rule studio.approval.rule.approver studio.approval.rule.delegate
studio.export.model studio.export.wizard studio.export.wizard.data studio.mixin
survey.invite survey.question survey.question.answer survey.survey
survey.user_input survey.user_input.line talent.pool.add.applicants
task.share.wizard template.reset.mixin theme.ir.asset theme.ir.attachment
theme.ir.ui.view theme.utils theme.website.menu theme.website.page timer.mixin
timer.parent.mixin timer.timer timesheet.grid.mixin timesheets.analysis.report
uom.uom update.product.attribute.value utm.campaign utm.medium utm.mixin
utm.source utm.source.mixin utm.stage utm.tag validate.account.move
vendor.delay.report voip.call voip.country.code.mixin voip.provider
voip.queue.mixin web_tour.tour web_tour.tour.step website website.assets
website.base.unit website.checkout.step website.configurator.feature
website.controller.page website.cover_properties.mixin
website.custom_blocked_third_party_domains website.event.menu
website.html.text.processor website.menu website.multi.mixin website.page
website.page.properties website.page.properties.base website.page_options.mixin
website.page_visibility_options.mixin website.published.mixin
website.published.multi.mixin website.rewrite website.robots website.route
website.sale.extra.field website.searchable.mixin website.seo.metadata
website.snippet.filter website.technical.page website.track website.visitor
website.visitor.push.subscription whatsapp.account whatsapp.composer
whatsapp.message whatsapp.partner.bsuid whatsapp.preview whatsapp.register.phone
whatsapp.template whatsapp.template.button whatsapp.template.variable
wizard.ir.model.menu.create worksheet.template worksheet.template.load.wizard
x_project_task_worksheet_template_1
""".split()
