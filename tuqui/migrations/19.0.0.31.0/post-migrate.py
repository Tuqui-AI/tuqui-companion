from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    if not version:
        return
    # The dispatch cron is noupdate: move it to the trigger-driven schedule, and
    # wake it once for whatever was queued under the old one-minute interval.
    env = api.Environment(cr, SUPERUSER_ID, {})
    cron = env.ref("tuqui.ir_cron_tuqui_event_dispatch", raise_if_not_found=False)
    if cron:
        cron.write({"interval_number": 9999, "interval_type": "months"})
        cron._trigger()
