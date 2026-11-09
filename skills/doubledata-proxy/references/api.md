# DoubleData public REST API (fallback without MCP)

Base URL: `https://app.proxy.doubledata.com/api/v1`
Auth: `Authorization: Bearer $DOUBLEDATA_API_KEY` (organization API key, `dd_live_...`).
Full reference: https://doubledata.mintlify.app/api-reference/introduction

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/balance` | Wallet balance in cents |
| GET | `/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&username=` | Bandwidth, requests and spend, total and per credential |
| GET | `/proxies` | List credentials (no passwords) |
| POST | `/proxies` | Create credential: `{"name":"agent","proxy_type":"residential"}` |
| GET | `/proxies/{username}` | Credential with password and connection details |
| DELETE | `/proxies/{username}` | Delete credential |
| GET/PUT | `/proxies/{username}/limits` | Traffic limits in MB |
| GET | `/invoices?limit=&starting_after=&status=` | List invoices |
| GET | `/invoices/{invoiceId}` | One invoice |
| GET | `/invoices/{invoiceId}/pdf` | Invoice PDF download |
| GET | `/isp/catalog` | ISP tiers, countries and prices |
| POST | `/isp/quotes` | Quote an ISP package |
| POST | `/isp/orders` | Buy a quote: `{"quote_id":"..."}` |
| GET | `/isp/orders/{orderId}` | Order status |
| GET | `/isp/subscriptions` | Active ISP subscriptions |
| DELETE | `/isp/subscriptions/{id}` | Cancel renewal |
| GET | `/isp/subscriptions/{id}/proxies` | Static IPs with credentials |
| POST | `/isp/subscriptions/{id}/rotations` | Rotate IPs: `{"ips":["203.0.113.4"]}` |
| GET | `/isp/rotations/{rotationId}` | Rotation status |
| GET/PUT/DELETE | `/isp/subscriptions/{id}/ip-authorization` | Password-less access for one IPv4 |

Errors: `{"error":{"code":"...","message":"..."}}` with `X-Request-ID`. 429 responses carry `Retry-After`.

```bash
curl -s https://app.proxy.doubledata.com/api/v1/usage -H "Authorization: Bearer $DOUBLEDATA_API_KEY"
curl -sOJ https://app.proxy.doubledata.com/api/v1/invoices/in_123/pdf -H "Authorization: Bearer $DOUBLEDATA_API_KEY"
```
