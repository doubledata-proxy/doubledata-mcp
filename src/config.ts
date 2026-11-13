import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_API_URL = "https://app.proxy.doubledata.com/api/v1";
export const DASHBOARD_API_KEY_URL = "https://app.proxy.doubledata.com/dashboard/team";

export const TOOLSETS = ["account", "billing", "credentials", "proxy", "invoices", "isp"] as const;
export type Toolset = (typeof TOOLSETS)[number];

export type Config = {
  apiKey: string | null;
  apiKeySource: "env" | "file" | null;
  apiUrl: string;
  toolsets: Set<Toolset>;
  readOnly: boolean;
  outputDir: string;
  proxyUsername: string | null;
  proxyPassword: string | null;
  maxResponseChars: number;
};

type Env = Record<string, string | undefined>;

const apiKeyPattern = /^dd_live_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/;

export function isWellFormedAPIKey(value: string) {
  return apiKeyPattern.test(value.trim());
}

// Credentials live outside any project so they are never committed by accident.
export function credentialsPath(env: Env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "doubledata", "credentials.json");
}

export async function readStoredAPIKey(env: Env = process.env): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(env), "utf8")) as { api_key?: unknown };
    return typeof parsed.api_key === "string" && isWellFormedAPIKey(parsed.api_key) ? parsed.api_key : null;
  } catch {
    return null;
  }
}

export async function storeAPIKey(apiKey: string, env: Env = process.env) {
  const path = credentialsPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ api_key: apiKey.trim() }, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function removeStoredAPIKey(env: Env = process.env) {
  await rm(credentialsPath(env), { force: true });
}

function parseToolsets(value: string | undefined): Set<Toolset> {
  if (!value || value.trim() === "" || value.trim() === "all") return new Set(TOOLSETS);
  const selected = value.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = selected.filter((item) => !TOOLSETS.includes(item as Toolset));
  if (unknown.length > 0) {
    throw new Error(`Unknown DOUBLEDATA_TOOLSETS value: ${unknown.join(", ")}. Use ${TOOLSETS.join(", ")} or all.`);
  }
  return new Set(selected as Toolset[]);
}

function truthy(value: string | undefined) {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export async function loadConfig(env: Env = process.env, cwd = process.cwd()): Promise<Config> {
  const envKey = env.DOUBLEDATA_API_KEY?.trim() || null;
  const fileKey = envKey ? null : await readStoredAPIKey(env);
  const apiUrl = (env.DOUBLEDATA_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
  const url = new URL(apiUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("DOUBLEDATA_API_URL must use https unless it points to localhost.");
  }
  const maxChars = Number(env.DOUBLEDATA_MAX_RESPONSE_CHARS ?? "40000");
  return {
    apiKey: envKey ?? fileKey,
    apiKeySource: envKey ? "env" : fileKey ? "file" : null,
    apiUrl,
    toolsets: parseToolsets(env.DOUBLEDATA_TOOLSETS),
    readOnly: truthy(env.DOUBLEDATA_READ_ONLY),
    outputDir: resolve(cwd, env.DOUBLEDATA_OUTPUT_DIR?.trim() || "doubledata-exports"),
    proxyUsername: env.DOUBLEDATA_PROXY_USERNAME?.trim() || null,
    proxyPassword: env.DOUBLEDATA_PROXY_PASSWORD || null,
    maxResponseChars: Number.isInteger(maxChars) && maxChars >= 1000 ? Math.min(maxChars, 500_000) : 40_000,
  };
}
