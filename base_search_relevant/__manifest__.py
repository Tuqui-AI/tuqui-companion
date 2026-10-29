{
    "name": "Relevance Search",
    "version": "19.0.3.7.0",
    "category": "Technical",
    "summary": "Ranked text search over the models an administrator enables, on an index table of its own",
    "author": "Tuqui-AI",
    "website": "https://tuqui.com",
    "license": "LGPL-3",
    # mail: the chatter is scoped by Odoo's own rule for a message. tuqui: this
    # module also publishes the search to it (the tuqui_* files, which move out
    # the day there is a second consumer).
    "depends": ["base", "mail", "tuqui"],
    "data": [
        "security/ir.model.access.csv",
        "data/cron_search_relevant.xml",
        "views/search_relevant_config_views.xml",
        "views/tuqui_settings_views.xml",
    ],
    "installable": True,
    "application": False,
    "auto_install": False,
}
