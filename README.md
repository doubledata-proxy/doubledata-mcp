# DoubleData Proxy for AI agents

MCP server and agent skills for [DoubleData Proxy](https://proxy.doubledata.com). Your agent can manage the whole account and use the proxy network:

- **"How much do I have left? What did I use this month?"**: balance, bandwidth, requests and spend, totals and per credential.
- **"Make a proxy for my scraper, capped at 5 GB a month."**: create, list, limit and delete residential, datacenter and mobile credentials.
- **"Open this page from a German residential IP."**: fetch any URL through the network with country, city and sticky-session targeting. HTML comes back as Markdown.
- **"Give me 500 US sticky proxies for Playwright."**: proxy lists and ready-to-paste connection snippets.
- **"Download all invoices since January for my accountant."**: invoice PDFs plus a CSV index.
- **"Buy 10 private US ISP IPs" / "rotate these two IPs"**: Static ISP proxies from quote to rotation.
- **"Add $50 from my card and buy 10 GB of residential traffic."**: top up the balance from a saved card and buy traffic packages.

Everything you ask for can also be saved as a file (CSV, JSON, PDF, proxy lists) in a local export directory.

## Quick start

1. **Get an API key.** Run this in a terminal:

   ```bash
   npx -y github:doubledata-proxy/doubledata-mcp login
   ```

   It opens [Dashboard › Team](https://app.proxy.doubledata.com/dashboard/team), where an organization admin creates the key. Paste the key at the hidden prompt. It is checked against the API and saved to `~/.config/doubledata/credentials.json` with mode `600`. You can also set `DOUBLEDATA_API_KEY` instead.

2. **Add the server to your agent** (below).

3. Ask: *"Give me an overview of my DoubleData account."*

## Install

The server runs over stdio and needs Node.js 20.18 or later.

### Claude Code: plugin (MCP server and skills)

```bash
claude plugin marketplace add doubledata-proxy/doubledata-mcp
```

```bash
claude plugin install doubledata@doubledata
```

To install only the MCP server:

```bash
claude mcp add doubledata -- npx -y github:doubledata-proxy/doubledata-mcp
```

### Codex

```bash
codex mcp add doubledata -- npx -y github:doubledata-proxy/doubledata-mcp
```

### Cursor (`~/.cursor/mcp.json`), Claude Desktop (`claude_desktop_config.json`), Windsurf

```json
{
  "mcpServers": {
    "doubledata": {
      "command": "npx",
      "args": ["-y", "github:doubledata-proxy/doubledata-mcp"]
    }
  }
}
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "doubledata": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:doubledata-proxy/doubledata-mcp"]
    }
  }
}
```

GUI apps such as Claude Desktop may not see a key stored by `login` if they run with a different home directory. In that case add `"env": { "DOUBLEDATA_API_KEY": "dd_live_..." }` to the server entry.

### Skills for other agents

The [`skills/`](skills) folder holds standard `SKILL.md` agent skills: `doubledata-proxy` for account, billing and credentials, and `web-through-proxy` for fetching through the network. Copy them into your agent's skills directory, for example `~/.claude/skills/` or `.agents/skills/`. They also cover agents that use the REST API without MCP.

## Tools

| Toolset | Tools |
| --- | --- |
| `account` | `account_overview`, `get_balance`, `get_usage`, `export_usage` |
| `billing` | `traffic_products`, `buy_traffic`, `list_payment_methods`, `add_funds` |
| `credentials` | `list_credentials`, `get_credential`, `create_credential`, `delete_credential`, `get_traffic_limits`, `set_traffic_limits` |
| `proxy` | `proxy_request`, `check_exit_ip`, `build_proxy_config`, `export_proxy_list` |
| `invoices` | `list_invoices`, `get_invoice`, `download_invoice`, `download_all_invoices` |
| `isp` | `isp_catalog`, `isp_quote`, `isp_order`, `isp_order_status`, `isp_subscriptions`, `isp_proxies`, `isp_rotate`, `isp_rotation_status`, `isp_get_ip_authorization`, `isp_set_ip_authorization`, `isp_cancel_renewal` |

There is also a `proxy-guide` resource (gateways, ports and targeting syntax) and two prompts, `account_report` and `fetch_from_country`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOUBLEDATA_API_KEY` | key saved by `login` | Organization API key |
| `DOUBLEDATA_TOOLSETS` | `all` | Comma list to expose, e.g. `account,invoices` |
| `DOUBLEDATA_READ_ONLY` | `false` | `true` hides every tool that spends money or traffic or changes the account |
| `DOUBLEDATA_OUTPUT_DIR` | `./doubledata-exports` | Where reports, PDFs and proxy lists are written. Writes outside it are refused. |
| `DOUBLEDATA_PROXY_USERNAME` / `DOUBLEDATA_PROXY_PASSWORD` | first enabled credential | Default credential for proxy tools |
| `DOUBLEDATA_MAX_RESPONSE_CHARS` | `40000` | How much of a fetched page is returned to the model |

CLI commands: `doubledata-mcp login`, `logout`, `whoami`, `--help`.

## Safety by design

- **Confirmation for consequential actions.** `buy_traffic` and `isp_order` require `confirm_purchase: true`; `add_funds` requires `confirm_charge: true`. `delete_credential` and `isp_cancel_renewal` require repeating the identifier. Each tool carries MCP `readOnlyHint` and `destructiveHint` annotations, so clients can ask before running them.
- **Read-only mode** for dashboards and analysts.
- **Secrets stay out of chat.** Passwords are masked unless you ask. Snippets use `$DOUBLEDATA_PROXY_PASSWORD`. Files that contain passwords are written with mode `600`. The API key goes in a header, never in a URL.
- **Prompt-injection hygiene.** Fetched pages are wrapped as untrusted content, and redirects are returned rather than followed.
- **Spend control.** Give an agent its own credential with `set_traffic_limits`. `add_funds` charges at most $1,000 per call and per organization in 24 hours, and only saved cards that need no extra authentication. Purchases accept a `request_id`: retrying with the same one never charges twice. Set `DOUBLEDATA_READ_ONLY=true` or leave out the `billing` toolset to stop an agent from spending.


## How it compares

| | DoubleData MCP | Bright Data MCP | Webshare MCP |
| --- | :-: | :-: | :-: |
| Fetch pages through residential IPs with country, city and session targeting | ✅ | ✅ (via Web Unlocker zones) | — |
| Account usage, balance and spend | ✅ | — | ✅ |
| Create, limit and delete proxy credentials | ✅ | — | ✅ |
| Invoice list and PDF download | ✅ | — | — |
| Exports to files (CSV, JSON, PDF, proxy lists) | ✅ | — | — |
| Agent skills and plugin bundled | ✅ | — | — |
| Read-only mode and toolset filtering | ✅ | partial | — |
| API key kept out of URLs | ✅ | — (hosted URL token) | ✅ |

Bright Data's MCP focuses on scraping products such as SERP, Web Unlocker and Scraping Browser. This server focuses on running your own proxy account end to end.

## Development

```bash
npm install
```

```bash
npm run check
```

```bash
npm run inspect
```

`npm run check` runs typecheck, tests and build. `npm run inspect` opens the MCP Inspector against `dist/index.js`.

REST API reference: <https://doubledata.mintlify.app/api-reference/introduction>

## License

MIT
