import { z } from "zod";
import type { CredentialSecret, ProxyType } from "../client.js";
import { maskSecret } from "../proxy.js";
import type { ToolContext } from "./shared.js";
import { defineTool, json } from "./shared.js";

export const usernameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, "Use the credential's base username, without targeting suffixes.");
export const proxyTypeSchema = z.enum(["residential", "datacenter", "mobile"]);

const passwordCache = new WeakMap<ToolContext, Map<string, string>>();

function cacheFor(context: ToolContext) {
  let cache = passwordCache.get(context);
  if (!cache) {
    cache = new Map();
    passwordCache.set(context, cache);
  }
  return cache;
}

export function rememberPassword(context: ToolContext, credential: Pick<CredentialSecret, "username" | "password">) {
  cacheFor(context).set(credential.username, credential.password);
}

// Picks the credential a proxy tool should use: an explicit username, the
// DOUBLEDATA_PROXY_* environment pair, or the first enabled credential of the
// requested product. Passwords are fetched once and kept in memory only.
export async function resolveProxyCredential(context: ToolContext, input: { username?: string; proxyType?: ProxyType }) {
  const { config, client } = context;
  const cache = cacheFor(context);
  if (input.username) {
    if (input.username === config.proxyUsername && config.proxyPassword) return { username: input.username, password: config.proxyPassword };
    const cached = cache.get(input.username);
    if (cached) return { username: input.username, password: cached };
    const credential = await client.getCredential(input.username);
    if (!credential.enabled) throw new Error(`Credential ${input.username} is disabled.`);
    rememberPassword(context, credential);
    return { username: credential.username, password: credential.password };
  }
  if (config.proxyUsername && config.proxyPassword && !input.proxyType) {
    return { username: config.proxyUsername, password: config.proxyPassword };
  }
  const proxyType = input.proxyType ?? "residential";
  const { credentials } = await client.listCredentials();
  const match = credentials.find((item) => item.enabled && item.proxy_type === proxyType);
  if (!match) {
    throw new Error(
      `No enabled ${proxyType} credential exists. Create one with create_credential (proxy_type "${proxyType}"), then retry.`,
    );
  }
  return resolveProxyCredential(context, { username: match.username });
}

function present(credential: CredentialSecret, reveal: boolean) {
  return { ...credential, password: reveal ? credential.password : maskSecret(credential.password) };
}

export const credentialTools = [
  defineTool({
    name: "list_credentials",
    toolset: "credentials",
    title: "List proxy credentials",
    description:
      "List residential, datacenter and mobile proxy credentials (username, name, product, enabled, traffic used, limits). Passwords are not included; use get_credential.",
    input: { proxy_type: proxyTypeSchema.optional().describe("Only return credentials for this product.") },
    run: async (args, { client }) => {
      const result = await client.listCredentials();
      const credentials = args.proxy_type ? result.credentials.filter((item) => item.proxy_type === args.proxy_type) : result.credentials;
      return json({ credentials, total: credentials.length });
    },
  }),
  defineTool({
    name: "get_credential",
    toolset: "credentials",
    title: "Get proxy credential",
    description:
      "Return one credential with gateway hosts and ports. The password is masked unless reveal_password is true; prefer proxy tools, which use the password without showing it.",
    input: {
      username: usernameSchema,
      reveal_password: z.boolean().default(false).describe("Show the plaintext password. Only when the user explicitly needs it."),
    },
    run: async (args, context) => {
      const credential = await context.client.getCredential(args.username);
      rememberPassword(context, credential);
      return json(present(credential, args.reveal_password));
    },
  }),
  defineTool({
    name: "create_credential",
    toolset: "credentials",
    title: "Create proxy credential",
    description:
      "Create a new proxy credential (username/password) for residential, datacenter or mobile traffic. Requires wallet balance or package GB for that product. Returns connection details; the password is masked unless reveal_password is true.",
    input: {
      name: z.string().trim().min(1).max(24).describe("Display name, up to 24 characters, e.g. the project or agent using it."),
      proxy_type: proxyTypeSchema.default("residential"),
      reveal_password: z.boolean().default(false),
    },
    mutates: true,
    annotations: { destructiveHint: false, idempotentHint: false },
    run: async (args, context) => {
      const credential = await context.client.createCredential({ name: args.name, proxy_type: args.proxy_type });
      rememberPassword(context, credential);
      return json(present(credential, args.reveal_password), `Created ${credential.proxy_type} credential ${credential.username}.`);
    },
  }),
  defineTool({
    name: "delete_credential",
    toolset: "credentials",
    title: "Delete proxy credential",
    description:
      "Permanently delete a proxy credential. Anything using it stops working immediately. Set confirm_username to the same username to proceed.",
    input: {
      username: usernameSchema,
      confirm_username: z.string().describe("Repeat the username to confirm deletion."),
    },
    mutates: true,
    annotations: { destructiveHint: true, idempotentHint: true },
    run: async (args, context) => {
      if (args.confirm_username !== args.username) throw new Error("confirm_username must exactly match username. Nothing was deleted.");
      await context.client.deleteCredential(args.username);
      cacheFor(context).delete(args.username);
      return json({ deleted: args.username });
    },
  }),
  defineTool({
    name: "get_traffic_limits",
    toolset: "credentials",
    title: "Get traffic limits",
    description: "Show a credential's total, daily, weekly and monthly traffic limits in MB and current consumption.",
    input: { username: usernameSchema },
    run: async (args, { client }) => json(await client.getTrafficLimits(args.username)),
  }),
  defineTool({
    name: "set_traffic_limits",
    toolset: "credentials",
    title: "Set traffic limits",
    description:
      "Cap how much traffic a credential may use. Values are MB; 0 removes that limit. Only the provided limits change. Useful to give an agent or teammate a bounded budget.",
    input: {
      username: usernameSchema,
      total_mb: z.number().int().min(0).optional(),
      daily_mb: z.number().int().min(0).optional(),
      weekly_mb: z.number().int().min(0).optional(),
      monthly_mb: z.number().int().min(0).optional(),
    },
    mutates: true,
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async (args, { client }) => {
      const limits = {
        ...(args.total_mb !== undefined ? { traffic_limit_mb: args.total_mb } : {}),
        ...(args.daily_mb !== undefined ? { daily_limit_mb: args.daily_mb } : {}),
        ...(args.weekly_mb !== undefined ? { weekly_limit_mb: args.weekly_mb } : {}),
        ...(args.monthly_mb !== undefined ? { monthly_limit_mb: args.monthly_mb } : {}),
      };
      if (Object.keys(limits).length === 0) throw new Error("Provide at least one limit.");
      return json(await client.setTrafficLimits(args.username, limits));
    },
  }),
];
