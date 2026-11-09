import { randomBytes } from "node:crypto";
import { ProxyAgent, request as undiciRequest } from "undici";

export const GATEWAYS = { eu: "proxy.doubledata.com", us: "us.proxy.doubledata.com" } as const;
export const PORTS = { http: 7777, https: 9999, socks5: 8888 } as const;

export type Gateway = keyof typeof GATEWAYS;
export type ProxyProtocol = keyof typeof PORTS;
export type Targeting = {
  country?: string;
  city?: string;
  session?: string;
  ttlMinutes?: number;
};

const countryPattern = /^[a-z]{2}$/;
const cityPattern = /^[a-z0-9]{1,64}$/;
const sessionPattern = /^[A-Za-z0-9]{1,64}$/;

export function newSessionId(length = 8) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

// The dashboard formats "New York" as "newyork"; accept human input and apply the same rule.
export function normalizeCity(city: string) {
  return city.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function buildProxyUsername(username: string, targeting: Targeting = {}) {
  let result = username;
  const country = targeting.country?.trim().toLowerCase();
  if (country) {
    if (!countryPattern.test(country)) throw new Error("Use a two-letter country code such as us or de.");
    result += `-country-${country}`;
  }
  if (targeting.city) {
    if (!country) throw new Error("City targeting requires a country.");
    const city = normalizeCity(targeting.city);
    if (!cityPattern.test(city)) throw new Error("The city name is invalid.");
    result += `-city-${city}`;
  }
  if (targeting.session) {
    if (!sessionPattern.test(targeting.session)) throw new Error("Session IDs use letters and digits only.");
    result += `-session-${targeting.session}`;
  }
  if (targeting.ttlMinutes !== undefined) {
    if (!targeting.session) throw new Error("A session TTL requires a session ID.");
    if (!Number.isInteger(targeting.ttlMinutes) || targeting.ttlMinutes < 1 || targeting.ttlMinutes > 120) {
      throw new Error("Session TTL must be an integer from 1 through 120 minutes.");
    }
    result += `-ttl-${targeting.ttlMinutes}`;
  }
  return result;
}

export const PROXY_FORMATS = [
  "url",
  "host:port:user:pass",
  "user:pass:host:port",
  "user:pass@host:port",
  "host:port@user:pass",
] as const;
export type ProxyFormat = (typeof PROXY_FORMATS)[number];

export function formatProxy(input: {
  username: string;
  password: string;
  protocol: ProxyProtocol;
  gateway: Gateway;
  format: ProxyFormat;
  encode?: boolean;
}) {
  const host = GATEWAYS[input.gateway];
  const port = PORTS[input.protocol];
  const encode = input.encode ?? true;
  const user = encode ? encodeURIComponent(input.username) : input.username;
  const pass = encode ? encodeURIComponent(input.password) : input.password;
  switch (input.format) {
    case "url":
      return `${input.protocol}://${user}:${pass}@${host}:${port}`;
    case "host:port:user:pass":
      return `${host}:${port}:${input.username}:${input.password}`;
    case "user:pass:host:port":
      return `${input.username}:${input.password}:${host}:${port}`;
    case "user:pass@host:port":
      return `${input.username}:${input.password}@${host}:${port}`;
    case "host:port@user:pass":
      return `${host}:${port}@${input.username}:${input.password}`;
  }
}

export function maskSecret(value: string) {
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}${"*".repeat(Math.min(12, value.length - 4))}${value.slice(-2)}`;
}

export type ProxyRequestInput = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  username: string;
  password: string;
  protocol: "http" | "https";
  gateway: Gateway;
  timeoutMs: number;
  maxBytes: number;
};

export type ProxyResponse = {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  truncated: boolean;
  elapsedMs: number;
};

export type ProxyRequester = (input: ProxyRequestInput) => Promise<ProxyResponse>;

// Sends one request through the DoubleData gateway. The proxy, not this
// process, resolves and connects to the destination.
export const sendThroughProxy: ProxyRequester = async (input) => {
  const destination = new URL(input.url);
  if (!["http:", "https:"].includes(destination.protocol)) throw new Error("Only http and https URLs are supported.");
  const proxyURL = `${input.protocol}://${GATEWAYS[input.gateway]}:${PORTS[input.protocol]}`;
  const token = `Basic ${Buffer.from(`${input.username}:${input.password}`).toString("base64")}`;
  const agent = new ProxyAgent({ uri: proxyURL, token, connectTimeout: input.timeoutMs });
  const started = Date.now();
  try {
    const response = await undiciRequest(destination, {
      method: input.method as never,
      headers: { "user-agent": "Mozilla/5.0 (compatible; doubledata-mcp)", ...input.headers },
      body: input.body,
      dispatcher: agent,
      headersTimeout: input.timeoutMs,
      bodyTimeout: input.timeoutMs,
      maxRedirections: 0,
    } as Parameters<typeof undiciRequest>[1]);
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk as Uint8Array);
      if (size + buffer.length > input.maxBytes) {
        chunks.push(buffer.subarray(0, input.maxBytes - size));
        size = input.maxBytes;
        truncated = true;
        response.body.destroy();
        break;
      }
      chunks.push(buffer);
      size += buffer.length;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    return { status: response.statusCode, headers, body: new Uint8Array(Buffer.concat(chunks)), truncated, elapsedMs: Date.now() - started };
  } finally {
    await agent.close().catch(() => undefined);
  }
};
