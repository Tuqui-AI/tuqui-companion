{
    "name": "MCP for Claude & ChatGPT",
    "version": "16.0.1.1.0",
    "category": "Productivity",
    "summary": (
        "Tuqui connects your Odoo to Claude, ChatGPT, Cursor and any MCP client via the Model "
        "Context Protocol, with nothing to install. This free module is optional and data-only — "
        "no Python, no dependencies — and works on Odoo Online, Odoo.sh and On-Premise. "
        "Standard OAuth 2.0: you control access and revoke it whenever you want."
    ),
    "author": "Tuqui-AI",
    "website": "https://tuqui.com",
    "license": "LGPL-3",
    "images": ["static/description/portada.png"],
    "depends": ["base"],
    "data": [
        "data/tuqui_mcp_data.xml",
    ],
    "installable": True,
    "application": False,
    "auto_install": False,
}
