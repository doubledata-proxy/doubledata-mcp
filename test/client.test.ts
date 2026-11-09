import { describe, expect, it } from "vitest";
import { DoubleDataAPIError, DoubleDataClient, MissingAPIKeyError } from "../src/client.js";
import { fakeAPI, jsonResponse } from "./helpers.js";

const apiKey = "dd_live_abcdefghijkl.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

function clientFor(routes: Parameters<typeof fakeAPI>[0]) {
  const api = fakeAPI(routes);
  const sleeps: number[] = [];
  const client = new DoubleDataClient({
    apiKey,
    apiUrl: "https://api.test/api/v1",
    fetch: api.fetchImpl,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { client, calls: api.calls, sleeps };
}

describe("DoubleDataClient", () => {
  it("sends the API key as a bearer token", async () => {
    const { client, calls } = clientFor({ "GET /balance": () => jsonResponse({ balance_cents: 1234, currency: "usd" }) });
    await expect(client.getBalance()).resolves.toEqual({ balance_cents: 1234, currency: "usd" });
    expect(calls[0]?.authorization).toBe(`Bearer ${apiKey}`);
  });

  it("retries rate-limited reads using Retry-After", async () => {
    let attempts = 0;
    const { client, sleeps } = clientFor({
      "GET /balance": () => (++attempts === 1 ? jsonResponse({ error: { code: "rate_limited", message: "slow down" } }, 429, { "Retry-After": "3" }) : jsonResponse({ balance_cents: 1, currency: "usd" })),
    });
    await client.getBalance();
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([3000]);
  });

  it("never retries mutations", async () => {
    let attempts = 0;
    const { client } = clientFor({
      "POST /proxies": () => {
        attempts += 1;
        return jsonResponse({ error: { code: "temporarily_unavailable", message: "down" } }, 503);
      },
    });
    await expect(client.createCredential({ name: "x", proxy_type: "residential" })).rejects.toBeInstanceOf(DoubleDataAPIError);
    expect(attempts).toBe(1);
  });

  it("surfaces API error codes, request IDs and the dashboard link on 401", async () => {
    const { client } = clientFor({
      "GET /usage": () => jsonResponse({ error: { code: "unauthorized", message: "Invalid API key." } }, 401, { "X-Request-ID": "req_1" }),
    });
    const error = (await client.getUsage().catch((caught: unknown) => caught)) as DoubleDataAPIError;
    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(error.requestId).toBe("req_1");
    expect(error.message).toContain("/dashboard/team");
  });

  it("fails fast without an API key", async () => {
    const client = new DoubleDataClient({ apiKey: null, apiUrl: "https://api.test/api/v1", fetch: (() => { throw new Error("must not fetch"); }) as typeof fetch });
    await expect(client.getBalance()).rejects.toBeInstanceOf(MissingAPIKeyError);
  });

  it("encodes path segments and reads the PDF filename", async () => {
    const { client, calls } = clientFor({
      "GET /invoices/in_123/pdf": () =>
        new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="DD-0001.pdf"' } }),
    });
    const file = await client.downloadInvoicePDF("in_123");
    expect(file.filename).toBe("DD-0001.pdf");
    expect(Array.from(file.bytes)).toEqual([37, 80, 68, 70]);
    expect(calls[0]?.path).toBe("/invoices/in_123/pdf");
  });
});
