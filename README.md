# fortnox-mcp

Open-source [MCP](https://modelcontextprotocol.io) server for **Fortnox**, the Swedish accounting system. Ask Claude, ChatGPT, Cursor or any MCP client about your books in plain language: unpaid invoices, the result for the quarter, what you owe suppliers, cash in the bank.

- **Read-only by default.** Write tools are not even registered unless you turn them on.
- **Reports Fortnox has no endpoint for**: income statement, balance sheet, receivables and payables ageing, monthly totals per account. Built from one SIE export per financial year, so they match the books exactly.
- **The whole API for reading.** 24 curated tools, plus `fortnox_get` for any of Fortnox's ~140 other read endpoints (assets, contracts, employees, price lists, warehouse…), checked against an allowlist generated from Fortnox's published OpenAPI document. Nothing that sends, prints or deletes is reachable.
- **Drafts, not actions.** With writes enabled, the server can create customers, offers, orders and *unbooked, unsent* invoice drafts. Every write returns a preview first and needs `confirm: true`. Bookkeeping, payments, sending and deleting stay in Fortnox, with a person.
- **Built for Fortnox's quirks**: rotating refresh tokens saved before use, a shared refresh for concurrent calls, requests paced under Fortnox's 25-per-5-seconds limit, CP437 SIE decoding.

Built and maintained by [Walma](https://walma.ai). The setup guide is [Fortnox MCP on walma.ai](https://walma.ai/guider/mcp/fortnox-mcp).

## Tools

| Area | Tools |
|---|---|
| Company | `get_company_info`, `list_financial_years` |
| Customer invoices | `list_invoices`, `get_invoice`, `list_invoice_payments` |
| Supplier invoices | `list_supplier_invoices`, `get_supplier_invoice` |
| Registers | `list_customers`, `get_customer`, `list_suppliers`, `get_supplier`, `list_articles`, `list_orders`, `list_offers`, `list_projects`, `list_cost_centers` |
| Bookkeeping | `list_accounts`, `list_vouchers`, `get_voucher` |
| Reports | `income_statement`, `balance_sheet`, `account_totals_by_month`, `receivables_aging`, `payables_aging` |
| Everything else (read) | `list_endpoints`, `fortnox_get` |
| Writes (opt-in, drafts) | `create_customer`, `create_invoice_draft`, `create_offer`, `create_order` |

## Setup

### 1. Create a Fortnox app

1. Sign up as an integration developer at [apps.fortnox.se/integration-developer](https://apps.fortnox.se/integration-developer/signup). You get a free test company to try against.
2. Create an app. Set the **redirect URI** to `http://localhost:8765/callback`.
3. Enable the scopes you need. The default set is `companyinformation bookkeeping invoice customer supplierinvoice supplier article payment settings`. Each scope also has to be covered by a licence on the Fortnox account that approves it, so ask only for what you use.
4. Note the **client ID** and **client secret**.

### 2. Connect your company

```bash
git clone https://github.com/Walma-Labs/fortnox-mcp.git
cd fortnox-mcp && npm install

FORTNOX_CLIENT_ID=… FORTNOX_CLIENT_SECRET=… node dist/cli.js login
```

Open the printed URL, sign in to Fortnox and approve. Tokens are saved to `~/.config/fortnox-mcp/tokens.json` (mode 600). The server refreshes them on its own; a connection used at least once every 45 days never needs a new login. `node dist/cli.js status` shows which company is connected.

### 3. Add it to your client

**Claude Code**

```bash
claude mcp add fortnox \
  -e FORTNOX_CLIENT_ID=… -e FORTNOX_CLIENT_SECRET=… \
  -- node /path/to/fortnox-mcp/dist/cli.js
```

**Claude Desktop / Cursor** (`claude_desktop_config.json`, `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "fortnox": {
      "command": "node",
      "args": ["/path/to/fortnox-mcp/dist/cli.js"],
      "env": {
        "FORTNOX_CLIENT_ID": "…",
        "FORTNOX_CLIENT_SECRET": "…"
      }
    }
  }
}
```

Then ask, for example:

- *Vilka kundfakturor är förfallna, och hos vilka kunder?*
- *Show the income statement for Q3 compared with Q2.*
- *What did we spend on external services (5000–6999) per month this year?*
- *Hur mycket har vi på företagskontot, och vad ska betalas till leverantörer de närmaste två veckorna?*

## Configuration

| Variable | Meaning |
|---|---|
| `FORTNOX_CLIENT_ID`, `FORTNOX_CLIENT_SECRET` | From your app in the Developer Portal |
| `FORTNOX_REDIRECT_URI` | Default `http://localhost:8765/callback`; must match the portal exactly |
| `FORTNOX_SCOPES` | Space-separated scopes requested at login (default above) |
| `FORTNOX_ACCOUNT_TYPE` | `service` for a service account (approver must be a system administrator) |
| `FORTNOX_TOKEN_FILE` | Default `~/.config/fortnox-mcp/tokens.json` |
| `FORTNOX_ACCESS_TOKEN` | A ready access token instead of the token file; no refresh |
| `FORTNOX_ENABLE_WRITES` | `true` registers the draft-only write tools |

### HTTP

`node dist/http.js` serves streamable HTTP (stateless) on `PORT` (default 8080). With `FORTNOX_TOKEN_FROM_HEADER=true` each request carries its own token in `X-Fortnox-Access-Token`, for hosts that run OAuth per customer. The HTTP server has **no authentication of its own**: put an authenticating gateway in front of it and never expose it publicly.

## Safety model

- Read tools carry `readOnlyHint`; write tools are absent unless `FORTNOX_ENABLE_WRITES=true`.
- Writes return a dry-run preview of the exact request body. The model is instructed to show it and wait for approval before calling again with `confirm: true`.
- A `POST` is never retried after a server error, since Fortnox may already have created the document.
- `fortnox_get` only reaches paths in `src/paths.ts`, generated from Fortnox's OpenAPI document by `scripts/gen-paths.py`, minus endpoints that send (email, e-print, e-invoice), return files, or belong to the bank and developer programmes.
- Tokens never reach the model; error text is scrubbed of anything that looks like a credential.

Your accounting data goes from Fortnox to the MCP client you use and from there to that client's model provider. If that matters (it usually does for bookkeeping), run the client through a gateway with an EU region and a log. That is what [Walma AI Hub](https://walma.ai/ai-hub) does.

## Development

```bash
npm install
npm test        # vitest, no network or credentials needed
npm run build
```

To refresh the endpoint allowlist after Fortnox changes its API:

```bash
curl -sL https://apps.fortnox.se/apidocs -o /tmp/apidocs.html
python3 scripts/gen-paths.py /tmp/apidocs.html > src/paths.ts
```

## Status

Built from Fortnox's API reference and the patterns of Walma's own production Fortnox integration (OAuth, rotating tokens, SIE). The test suite covers the wire protocol, pagination, the allowlist, token rotation and the reports. **Not yet verified end to end against a live Fortnox test company**; issues and pull requests are welcome.

Not affiliated with or endorsed by Fortnox AB.

## License

MIT © Walma AI AB
