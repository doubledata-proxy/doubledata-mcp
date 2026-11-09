---
name: doubledata-proxy
description: Use when the user asks about their DoubleData Proxy account — balance, bandwidth usage, spend, proxy credentials (create, list, delete, limits), invoices (list, download PDFs, accounting export), ISP static proxies (quote, buy, rotate) — or wants to connect to DoubleData proxies, generate a proxy list, or set up a DoubleData API key.
---

# DoubleData Proxy account

DoubleData sells residential, datacenter, mobile and ISP (static) proxies. Everything here works through the `doubledata` MCP server tools. If those tools are not available, use the REST API directly (see `references/api.md`).

## First run: API key

Tools fail with "No DoubleData API key is configured" until a key exists. Then:

1. Tell the user to run `npx -y github:doubledata-proxy/doubledata-mcp login` **in their own terminal**. It opens https://app.proxy.doubledata.com/dashboard/team, where an organization ADMIN creates the key (Team › API key › Create; it is shown once), then reads it with hidden input, verifies it and stores it in `~/.config/doubledata/credentials.json` (mode 600).
2. Alternative: set `DOUBLEDATA_API_KEY` in the MCP server's environment.
3. Never ask the user to paste the key into chat, and never write it into project files.

No account yet? Send them to https://app.proxy.doubledata.com to register and top up.

## Answering "what do I have / how much did I use"

Call `account_overview` first — one call returns wallet balance, this month's GB/requests/spend, top credentials, credential count, ISP subscriptions and open invoices. Drill down with:

| Question | Tool |
| --- | --- |
| Usage for a period or one credential | `get_usage` (`from`/`to` as UTC `YYYY-MM-DD`, `to` exclusive) |
| A file/spreadsheet of usage | `export_usage` (`csv` or `json`) |
| Which credentials exist | `list_credentials` |
| Invoices / receipts | `list_invoices`, `download_invoice`, `download_all_invoices` |
| ISP static IPs | `isp_subscriptions`, `isp_proxies` |

Report bytes as GB (1 GB = 10^9 bytes) and money in USD. Mention file paths for anything saved.

## Credentials

- `create_credential` needs a `name` (≤24 chars) and `proxy_type` (`residential` default, `datacenter`, `mobile`). It fails with HTTP 402 `insufficient_balance` when the wallet and the product's GB package are both empty — tell the user to top up in the dashboard.
- Bound an agent's spend with `set_traffic_limits` (MB; 0 removes a limit).
- `delete_credential` is permanent and needs `confirm_username`; ask the user before deleting.
- Passwords stay masked. Only pass `reveal_password: true` when the user explicitly asks to see it.

## Connecting to proxies

See `references/targeting.md` for gateways, ports and username targeting. Use `build_proxy_config` for a connection string plus curl/Python/Node/Playwright snippets (password stays in `DOUBLEDATA_PROXY_PASSWORD` by default), and `export_proxy_list` for a file of N sticky sessions for scrapers. To actually fetch pages, use the `web-through-proxy` skill.

## Money-moving and destructive actions

- ISP purchase: `isp_catalog` → `isp_quote` → show the total and get an explicit yes → `isp_order` with `confirm_purchase: true` → poll `isp_order_status`.
- `isp_rotate` replaces IPs (old ones stop working) and uses the rotation allowance; confirm first.
- `isp_cancel_renewal` needs `confirm_subscription_id`.

## Errors

Errors include the API code and a request ID. Common ones: `unauthorized` (key revoked — create a new one), `insufficient_balance` (top up), `rate_limited` (wait `Retry-After`), `temporarily_unavailable` (retry later), `not_found` (wrong username/ID or another organization's resource).
