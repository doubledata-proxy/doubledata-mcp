import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DoubleDataClient } from "../src/client.js";
import { TOOLSETS, type Config } from "../src/config.js";
import type { ProxyRequester } from "../src/proxy.js";
import { createServer } from "../src/server.js";

export type Route = (request: { method: string; path: string; query: URLSearchParams; body: unknown }) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function fakeAPI(routes: Record<string, Route>) {
  const calls: Array<{ method: string; path: string; body: unknown; authorization: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, authorization: new Headers(init?.headers).get("Authorization") });
    const route = routes[`${method} ${path}`];
    if (!route) return jsonResponse({ error: { code: "not_found", message: `No fake route for ${method} ${path}` } }, 404);
    return route({ method, path, query: url.searchParams, body });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export async function testConfig(overrides: Partial<Config> = {}): Promise<Config> {
  return {
    apiKey: "dd_live_abcdefghijkl.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
    apiKeySource: "env",
    apiUrl: "https://api.test/api/v1",
    toolsets: new Set(TOOLSETS),
    readOnly: false,
    outputDir: await mkdtemp(join(tmpdir(), "doubledata-mcp-")),
    proxyUsername: null,
    proxyPassword: null,
    maxResponseChars: 40_000,
    ...overrides,
  };
}

export async function connect(options: { routes?: Record<string, Route>; config?: Partial<Config>; sendThroughProxy?: ProxyRequester }) {
  const config = await testConfig(options.config);
  const api = fakeAPI(options.routes ?? {});
  const client = new DoubleDataClient({ apiKey: config.apiKey, apiUrl: config.apiUrl, fetch: api.fetchImpl, sleep: async () => undefined });
  const { server } = createServer({
    config,
    client,
    sendThroughProxy: options.sendThroughProxy ?? (async () => { throw new Error("no proxy in tests"); }),
    now: () => new Date("2026-11-09T12:00:00Z"),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await mcp.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { isError: Boolean(result.isError), text: content.map((item) => item.text).join("\n") };
  };
  return { mcp, call, config, calls: api.calls };
}
