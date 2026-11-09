import { describe, expect, it } from "vitest";
import { buildProxyUsername, formatProxy, maskSecret, newSessionId } from "../src/proxy.js";

describe("buildProxyUsername", () => {
  it("returns the base username for rotating traffic", () => {
    expect(buildProxyUsername("resi_abc")).toBe("resi_abc");
  });

  it("appends country, normalized city, session and ttl in gateway order", () => {
    expect(buildProxyUsername("resi_abc", { country: "US", city: "New York", session: "a1b2", ttlMinutes: 30 })).toBe(
      "resi_abc-country-us-city-newyork-session-a1b2-ttl-30",
    );
  });

  it("strips accents from city names", () => {
    expect(buildProxyUsername("resi_abc", { country: "br", city: "São Paulo" })).toBe("resi_abc-country-br-city-saopaulo");
  });

  it.each([
    [{ city: "Paris" }, "City targeting requires a country."],
    [{ ttlMinutes: 10 }, "A session TTL requires a session ID."],
    [{ session: "a1", ttlMinutes: 121 }, "Session TTL must be an integer from 1 through 120 minutes."],
    [{ country: "usa" }, "Use a two-letter country code such as us or de."],
    [{ session: "bad-id" }, "Session IDs use letters and digits only."],
  ])("rejects invalid targeting %j", (targeting, message) => {
    expect(() => buildProxyUsername("resi_abc", targeting)).toThrow(message);
  });
});

describe("formatProxy", () => {
  const base = { username: "resi_abc-country-de", password: "p@ss:word", gateway: "eu" as const };

  it("percent-encodes credentials in URLs", () => {
    expect(formatProxy({ ...base, protocol: "http", format: "url" })).toBe("http://resi_abc-country-de:p%40ss%3Aword@proxy.doubledata.com:7777");
  });

  it("uses the protocol port and gateway host for line formats", () => {
    expect(formatProxy({ ...base, protocol: "socks5", gateway: "us", format: "host:port:user:pass" })).toBe(
      "us.proxy.doubledata.com:8888:resi_abc-country-de:p@ss:word",
    );
  });
});

describe("helpers", () => {
  it("generates distinct alphanumeric session IDs", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newSessionId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
  });

  it("masks all but the edges of a secret", () => {
    expect(maskSecret("abcdefghij")).toBe("ab******ij");
    expect(maskSecret("abc")).toBe("****");
  });
});
