# Proxy gateways, ports and targeting

| Gateway | Host |
| --- | --- |
| EU (default) | `proxy.doubledata.com` |
| US | `us.proxy.doubledata.com` |

Pick the gateway closest to the machine making requests; the exit country is chosen by targeting, not by the gateway.

| Protocol | Port |
| --- | --- |
| HTTP | 7777 |
| HTTPS (TLS to the proxy) | 9999 |
| SOCKS5 | 8888 |

## Username targeting

Append options to the credential username, in this order:

| Option | Example | Notes |
| --- | --- | --- |
| Country | `-country-us` | ISO 3166-1 alpha-2, lowercase |
| City | `-city-newyork` | Requires country. Lowercase, letters and digits only. Not for mobile. |
| Sticky session | `-session-a1b2c3` | Same session ID keeps the same exit IP |
| Session lifetime | `-ttl-30` | Minutes, 1–120. Requires a session. |

Examples:

```
resi_0123456789abcdef                                   rotating IP every request
resi_0123456789abcdef-country-de                        rotating German IPs
resi_0123456789abcdef-country-us-city-newyork-session-k3j9-ttl-60
```

```bash
curl --proxy http://proxy.doubledata.com:7777 \
  --proxy-user "resi_0123456789abcdef-country-gb:$DOUBLEDATA_PROXY_PASSWORD" \
  https://ipinfo.io/json
```

ISP proxies are different: each static IP has its own `ip:port:username:password` from `isp_proxies`, or no password when the caller's IP is set with `isp_set_ip_authorization`.
