import { z } from "zod";
import { htmlToMarkdown, isTextual, truncate, untrusted } from "../content.js";
import { resolveOutputPath, writeOutput } from "../files.js";
import { buildProxyUsername, formatProxy, GATEWAYS, newSessionId, PORTS, PROXY_FORMATS, type Targeting } from "../proxy.js";
import { proxyTypeSchema, resolveProxyCredential, usernameSchema } from "./credentials.js";
import { defineTool, json, text } from "./shared.js";

const targeting = {
  username: usernameSchema.optional().describe("Credential to use. Defaults to DOUBLEDATA_PROXY_USERNAME or the first enabled credential of proxy_type."),
  proxy_type: proxyTypeSchema.optional().describe("Product to use when no username is given. Defaults to residential."),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe("Two-letter exit country, e.g. us, de, gb."),
  city: z.string().max(64).optional().describe("Exit city within the country, e.g. 'New York' (residential/datacenter only)."),
  session: z.string().regex(/^[A-Za-z0-9]{1,64}$/).optional().describe("Sticky session ID. Reuse it to keep the same exit IP."),
  ttl_minutes: z.number().int().min(1).max(120).optional().describe("Sticky session lifetime, 1-120 minutes. Requires session."),
  gateway: z.enum(["eu", "us"]).default("eu").describe("Entry gateway closest to you. It does not choose the exit country."),
};

function targetingOf(args: { country?: string; city?: string; session?: string; ttl_minutes?: number }): Targeting {
  return { country: args.country, city: args.city, session: args.session, ttlMinutes: args.ttl_minutes };
}

const ipEchoURL = "https://ipinfo.io/json";

export const proxyTools = [
  defineTool({
    name: "proxy_request",
    toolset: "proxy",
    title: "Send HTTP request through proxy",
    description:
      "Fetch a URL through the DoubleData proxy network with optional country/city targeting and sticky sessions. Returns status, key headers and the body (HTML converted to Markdown by default, truncated to a safe size). Use save_to to download the raw response to a file. Consumes proxy traffic.",
    input: {
      url: z.string().url().describe("Destination http(s) URL."),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
      headers: z.record(z.string(), z.string()).optional().describe("Extra request headers."),
      body: z.string().max(1_000_000).optional().describe("Request body for POST/PUT/PATCH."),
      ...targeting,
      protocol: z.enum(["http", "https"]).default("https").describe("Connection to the proxy: https (port 9999, encrypted) or http (port 7777)."),
      response_format: z.enum(["markdown", "text", "raw"]).default("markdown").describe("markdown simplifies HTML; text returns the body as-is; raw returns only metadata unless saved."),
      max_chars: z.number().int().min(500).max(500_000).optional().describe("Maximum characters of body returned to the agent."),
      timeout_ms: z.number().int().min(1000).max(120_000).default(30_000),
      save_to: z.string().optional().describe("Save the full response body to this relative path inside the export directory."),
    },
    mutates: true,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (args, context) => {
      const credential = await resolveProxyCredential(context, { username: args.username, proxyType: args.proxy_type });
      const proxyUsername = buildProxyUsername(credential.username, targetingOf(args));
      const response = await context.sendThroughProxy({
        url: args.url,
        method: args.method,
        headers: args.headers,
        body: args.body,
        username: proxyUsername,
        password: credential.password,
        protocol: args.protocol,
        gateway: args.gateway,
        timeoutMs: args.timeout_ms,
        maxBytes: args.save_to ? 100 * 1024 * 1024 : 10 * 1024 * 1024,
      });
      const contentType = response.headers["content-type"] ?? "";
      const keep = ["content-type", "content-length", "location", "server", "retry-after", "cf-ray", "set-cookie"];
      const summary: Record<string, unknown> = {
        status: response.status,
        elapsed_ms: response.elapsedMs,
        proxy: { username: credential.username, targeting: proxyUsername.slice(credential.username.length) || "(rotating)", gateway: GATEWAYS[args.gateway], protocol: args.protocol },
        headers: Object.fromEntries(Object.entries(response.headers).filter(([key]) => keep.includes(key))),
        body_bytes: response.body.byteLength,
        body_truncated_at_limit: response.truncated,
      };
      if (args.save_to) {
        const path = resolveOutputPath(context.config.outputDir, args.save_to, "response.bin");
        await writeOutput(path, response.body);
        summary.saved_to = path;
      }
      if (args.response_format === "raw" || !isTextual(contentType)) {
        if (!isTextual(contentType)) summary.note = "Binary response; use save_to to keep it.";
        return json(summary);
      }
      const decoded = new TextDecoder().decode(response.body);
      const readable = args.response_format === "markdown" && contentType.includes("html") ? htmlToMarkdown(decoded) : decoded;
      const { text: body } = truncate(readable, args.max_chars ?? context.config.maxResponseChars);
      return text(`${JSON.stringify(summary, null, 2)}\n\n${untrusted(args.url, body)}`);
    },
  }),
  defineTool({
    name: "check_exit_ip",
    toolset: "proxy",
    title: "Check proxy exit IP",
    description:
      "Verify a proxy configuration by returning the exit IP, country, city and network seen by a public IP echo service. Use it to confirm targeting and sticky sessions work before a larger job.",
    input: { ...targeting, protocol: z.enum(["http", "https"]).default("https") },
    mutates: true,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: async (args, context) => {
      const credential = await resolveProxyCredential(context, { username: args.username, proxyType: args.proxy_type });
      const proxyUsername = buildProxyUsername(credential.username, targetingOf(args));
      const response = await context.sendThroughProxy({
        url: ipEchoURL,
        method: "GET",
        username: proxyUsername,
        password: credential.password,
        protocol: args.protocol,
        gateway: args.gateway,
        timeoutMs: 30_000,
        maxBytes: 64 * 1024,
      });
      if (response.status !== 200) {
        throw new Error(`The proxy returned HTTP ${response.status}. ${response.status === 407 ? "Check that the credential is enabled and funded." : ""}`.trim());
      }
      const info = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
      return json({
        ip: info.ip,
        country: info.country,
        region: info.region,
        city: info.city,
        network: info.org,
        elapsed_ms: response.elapsedMs,
        credential: credential.username,
        proxy_username: proxyUsername,
      });
    },
  }),
  defineTool({
    name: "build_proxy_config",
    toolset: "proxy",
    title: "Build proxy connection string",
    description:
      "Build a ready-to-use proxy URL or host:port:user:pass line with targeting, plus code snippets. By default the password is an environment-variable placeholder so secrets never land in code; set password_mode to 'plain' only when the user explicitly wants it.",
    input: {
      ...targeting,
      protocol: z.enum(["http", "https", "socks5"]).default("http"),
      format: z.enum(PROXY_FORMATS).default("url"),
      sticky: z.boolean().default(false).describe("Generate a random session ID when session is not set."),
      password_mode: z.enum(["env", "plain"]).default("env"),
    },
    run: async (args, context) => {
      const credential =
        args.password_mode === "plain"
          ? await resolveProxyCredential(context, { username: args.username, proxyType: args.proxy_type })
          : { username: args.username ?? context.config.proxyUsername ?? (await resolveProxyCredential(context, { proxyType: args.proxy_type })).username, password: "" };
      const session = args.session ?? (args.sticky ? newSessionId() : undefined);
      const proxyUsername = buildProxyUsername(credential.username, { ...targetingOf(args), session });
      const password = args.password_mode === "plain" ? credential.password : "${DOUBLEDATA_PROXY_PASSWORD}";
      const value = formatProxy({ username: proxyUsername, password, protocol: args.protocol, gateway: args.gateway, format: args.format, encode: args.password_mode === "plain" });
      const host = GATEWAYS[args.gateway];
      const port = PORTS[args.protocol];
      const curlScheme = args.protocol === "socks5" ? "socks5h" : args.protocol;
      return json({
        proxy: value,
        host,
        port,
        username: proxyUsername,
        password: args.password_mode === "plain" ? credential.password : "set DOUBLEDATA_PROXY_PASSWORD",
        session: session ?? null,
        snippets: {
          curl: `curl --proxy ${curlScheme}://${host}:${port} --proxy-user "${proxyUsername}:$DOUBLEDATA_PROXY_PASSWORD" https://ipinfo.io/json`,
          python_requests: `proxy = f"${args.protocol === "socks5" ? "socks5h" : args.protocol}://${proxyUsername}:{os.environ['DOUBLEDATA_PROXY_PASSWORD']}@${host}:${port}"\nrequests.get(url, proxies={"http": proxy, "https": proxy})`,
          node_undici: `new ProxyAgent({ uri: "${args.protocol === "socks5" ? "http" : args.protocol}://${host}:${args.protocol === "socks5" ? PORTS.http : port}", token: "Basic " + Buffer.from("${proxyUsername}:" + process.env.DOUBLEDATA_PROXY_PASSWORD).toString("base64") })`,
          playwright: `{ server: "${args.protocol === "socks5" ? "http" : args.protocol}://${host}:${args.protocol === "socks5" ? PORTS.http : port}", username: "${proxyUsername}", password: process.env.DOUBLEDATA_PROXY_PASSWORD }`,
        },
      });
    },
  }),
  defineTool({
    name: "export_proxy_list",
    toolset: "proxy",
    title: "Export proxy list file",
    description:
      "Write a proxy list file (one proxy per line) for scrapers and tools: N sticky sessions with unique IDs or rotating lines, in the chosen format. The file contains the real password and is created with owner-only permissions.",
    input: {
      ...targeting,
      count: z.number().int().min(1).max(10_000).default(100),
      sticky: z.boolean().default(true).describe("Give each line its own sticky session."),
      protocol: z.enum(["http", "https", "socks5"]).default("http"),
      format: z.enum(PROXY_FORMATS).default("url"),
      path: z.string().optional().describe("Relative output path inside the export directory."),
    },
    run: async (args, context) => {
      const credential = await resolveProxyCredential(context, { username: args.username, proxyType: args.proxy_type });
      const lines: string[] = [];
      const seen = new Set<string>();
      while (lines.length < args.count) {
        const session = args.sticky ? newSessionId() : undefined;
        if (session && seen.has(session)) continue;
        if (session) seen.add(session);
        const proxyUsername = buildProxyUsername(credential.username, { ...targetingOf(args), session });
        lines.push(formatProxy({ username: proxyUsername, password: credential.password, protocol: args.protocol, gateway: args.gateway, format: args.format }));
      }
      const name = `proxies-${credential.username}${args.country ? `-${args.country.toLowerCase()}` : ""}-${args.count}.txt`;
      const path = resolveOutputPath(context.config.outputDir, args.path, name);
      await writeOutput(path, `${lines.join("\n")}\n`, true);
      return text(`Saved ${lines.length} ${args.sticky ? "sticky" : "rotating"} proxies for ${credential.username} to ${path} (mode 600). Keep this file private.`);
    },
  }),
];
