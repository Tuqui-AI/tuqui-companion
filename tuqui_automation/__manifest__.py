{
    "name": "Tuqui Companion - Agent Triggers",
    "version": "18.0.1.1.0",
    "category": "Productivity",
    "summary": "Automation rules that trigger a Tuqui agent, manageable without being an Odoo administrator.",
    "author": "Tuqui-AI",
    "website": "https://tuqui.com",
    "license": "LGPL-3",
    "depends": [
        "tuqui",
        "base_automation",
    ],
    "data": [
        "security/tuqui_automation_security.xml",
        "security/ir.model.access.csv",
        "views/base_automation_views.xml",
        "views/tuqui_triggers_templates.xml",
    ],
    "assets": {
        "web.assets_backend": [
            "tuqui_automation/static/src/**/*",
        ],
        "web.assets_unit_tests": [
            "tuqui_automation/static/tests/**/*",
        ],
    },
    "installable": True,
    "application": False,
    "auto_install": True,
}
