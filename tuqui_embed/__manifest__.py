{
    "name": "Tuqui: Odoo in the chat panel",
    "summary": "Lets Tuqui show this Odoo in its side panel, with a panel-only session.",
    "version": "18.0.1.2.0",
    "category": "Productivity",
    "author": "Tuqui-AI",
    "website": "https://tuqui.com",
    "license": "LGPL-3",
    "depends": ["web", "web_tour", "bus", "tuqui"],
    "data": ["security/ir.model.access.csv"],
    "assets": {
        "web.assets_backend": [
            "tuqui_embed/static/src/no_tours_when_framed.js",
            "tuqui_embed/static/src/no_service_worker_when_framed.js",
            "tuqui_embed/static/src/cookies_when_framed.js",
        ],
        "web.assets_unit_tests": ["tuqui_embed/static/tests/**/*"],
    },
    "installable": True,
}
