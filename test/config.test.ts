import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsPath, loadConfig, removeStoredAPIKey, storeAPIKey } from "../src/config.js";

const key = "dd_live_abcdefghijkl.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

describe("config", () => {
  it("prefers the environment key over the stored key", async () => {
    const home = await mkdtemp(join(tmpdir(), "dd-home-"));
    const env = { XDG_CONFIG_HOME: home };
    await storeAPIKey(key.replace("abcdefghijkl", "zzzzzzzzzzzz"), env);
    const config = await loadConfig({ ...env, DOUBLEDATA_API_KEY: key }, "/work");
    expect(config.apiKey).toBe(key);
    expect(config.apiKeySource).toBe("env");
    expect(config.outputDir).toBe("/work/doubledata-exports");
  });

  it("stores the key with owner-only permissions and can remove it", async () => {
    const env = { XDG_CONFIG_HOME: await mkdtemp(join(tmpdir(), "dd-home-")) };
    const path = await storeAPIKey(key, env);
    expect(path).toBe(credentialsPath(env));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await loadConfig(env)).apiKeySource).toBe("file");
    await removeStoredAPIKey(env);
    expect((await loadConfig(env)).apiKey).toBeNull();
  });

  it("parses toolsets and read-only mode", async () => {
    const config = await loadConfig({ XDG_CONFIG_HOME: "/nonexistent", DOUBLEDATA_TOOLSETS: "account,invoices", DOUBLEDATA_READ_ONLY: "true" });
    expect([...config.toolsets]).toEqual(["account", "invoices"]);
    expect(config.readOnly).toBe(true);
  });

  it("rejects unknown toolsets and plain-http API URLs", async () => {
    await expect(loadConfig({ XDG_CONFIG_HOME: "/nonexistent", DOUBLEDATA_TOOLSETS: "account,billing" })).rejects.toThrow(/billing/);
    await expect(loadConfig({ XDG_CONFIG_HOME: "/nonexistent", DOUBLEDATA_API_URL: "http://example.com/api/v1" })).rejects.toThrow(/https/);
  });
});
