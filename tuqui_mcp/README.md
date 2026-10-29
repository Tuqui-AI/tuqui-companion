# MCP for Claude & ChatGPT

Tuqui connects your Odoo to Claude and ChatGPT. Ask about sales, stock, customers or overdue invoices in plain language, and the assistant answers with your real Odoo data.

It is a hosted MCP server: nothing to install in Odoo and no server to run.

- **Server URL:** `https://tuqui.com/mcp` (Streamable HTTP, OAuth sign-in)
- **Odoo versions:** 16, 17, 18, 19 and 20, Community and Enterprise
- **Hosting:** Odoo Online, Odoo.sh or your own server
- **Access:** read-only by default, within the permissions of each Odoo user

## Connect it

1. Create a Tuqui account at [tuqui.com](https://tuqui.com) and connect your Odoo (an admin user does it in a few steps).
2. Copy your workspace address from Settings → MCP server.
3. Add it as a custom connector:
   - **Claude:** Settings → Connectors → Add custom connector. On a Team plan, the workspace admin adds it.
   - **ChatGPT:** add it as a custom connector (MCP). Where the option lives depends on your plan.
4. Sign in with your Tuqui account when the assistant asks.

Step-by-step guides: [Claude](https://docs.tuqui.com/en/connect-claude) · [ChatGPT](https://docs.tuqui.com/en/connect-chatgpt)

## What you can ask

- "How much did we sell this month compared to the same month last year?"
- "Which customers have invoices more than 30 days overdue?"
- "Which products are below their minimum stock?"

## How it differs from a generic Odoo MCP

A generic MCP hands the assistant Odoo's tables and leaves the rest to it. Tuqui adds how Odoo works (invoices, stock moves, collections), your company's context and each user's, so the answers come with the full picture instead of loose rows.

## Links

- Website: [tuqui.com](https://tuqui.com)
- Docs (English, Spanish, French): [docs.tuqui.com](https://docs.tuqui.com)
- Odoo Apps: [MCP for Claude & ChatGPT](https://apps.odoo.com/apps/modules/19.0/tuqui_mcp)
- Contact: hello@tuqui.com

This repository describes the hosted server so MCP directories can list it. The server itself is not open source.
