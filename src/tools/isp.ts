import { z } from "zod";
import { resolveOutputPath, toCSV, writeOutput } from "../files.js";
import { maskSecret } from "../proxy.js";
import { defineTool, json, text } from "./shared.js";

const uuid = z.string().uuid();
const features = z.enum(["high_quality_ips", "unlimited_ip_authorizations", "high_concurrency", "double_concurrency", "high_priority_network"]);
const ipv4 = z.ipv4();

type ISPProxy = { ip: string; port: number; username: string; password: string; country: string; protocols?: string[] };

export const ispTools = [
  defineTool({
    name: "isp_catalog",
    toolset: "isp",
    title: "ISP proxy catalog",
    description: "Show ISP (static residential) proxy tiers, available countries with stock, add-on features and prices.",
    input: {},
    run: async (_args, { client }) => json(await client.ispCatalog()),
  }),
  defineTool({
    name: "isp_quote",
    toolset: "isp",
    title: "Quote ISP proxies",
    description:
      "Price an ISP proxy package without buying it. Returns a quote_id valid for a short time and the total. Show the price to the user before calling isp_order.",
    input: {
      tier: z.enum(["shared", "private", "dedicated"]),
      countries: z.array(z.object({ country: z.string().regex(/^[A-Za-z]{2}$/), quantity: z.number().int().positive() })).min(1),
      term: z.enum(["monthly", "yearly"]).default("monthly"),
      bandwidth_gb: z.number().int().nonnegative().default(0),
      proxy_replacements: z.number().int().nonnegative().default(0),
      features: z.array(features).default([]),
    },
    mutates: true,
    annotations: { destructiveHint: false, idempotentHint: false },
    run: async (args, { client }) =>
      json(
        await client.ispQuote({
          ...args,
          countries: args.countries.map((item) => ({ country: item.country.toUpperCase(), quantity: item.quantity })),
        }),
      ),
  }),
  defineTool({
    name: "isp_order",
    toolset: "isp",
    title: "Buy ISP proxies",
    description:
      "Purchase a quoted ISP package. This charges the wallet. Only call after the user explicitly approved the quoted price; set confirm_purchase to true. Poll isp_order_status until the order completes.",
    input: { quote_id: uuid, confirm_purchase: z.literal(true).describe("Must be true; confirms the user approved the charge.") },
    mutates: true,
    annotations: { destructiveHint: true, idempotentHint: false },
    run: async (args, { client }) => json(await client.ispOrder(args.quote_id)),
  }),
  defineTool({
    name: "isp_order_status",
    toolset: "isp",
    title: "ISP order status",
    description: "Check an ISP order's provisioning status and the resulting subscription.",
    input: { order_id: uuid },
    run: async (args, { client }) => json(await client.ispOrderStatus(args.order_id)),
  }),
  defineTool({
    name: "isp_subscriptions",
    toolset: "isp",
    title: "List ISP subscriptions",
    description: "List active ISP subscriptions with countries, proxy count, renewal date, remaining rotations and IP authorization.",
    input: {},
    run: async (_args, { client }) => json(await client.ispSubscriptions()),
  }),
  defineTool({
    name: "isp_proxies",
    toolset: "isp",
    title: "List ISP proxies",
    description:
      "List the static IPs of an ISP subscription. Passwords are masked unless reveal_passwords is true. Set export_format to save a proxy list file (owner-only permissions) instead.",
    input: {
      subscription_id: uuid,
      reveal_passwords: z.boolean().default(false),
      export_format: z.enum(["host:port:user:pass", "url", "csv"]).optional(),
      path: z.string().optional(),
    },
    run: async (args, { client, config }) => {
      const { proxies } = (await client.ispProxies(args.subscription_id)) as { proxies: ISPProxy[] };
      if (args.export_format) {
        const content =
          args.export_format === "csv"
            ? toCSV(["ip", "port", "username", "password", "country"], proxies.map((item) => [item.ip, item.port, item.username, item.password, item.country]))
            : `${proxies
                .map((item) =>
                  args.export_format === "url"
                    ? `http://${encodeURIComponent(item.username)}:${encodeURIComponent(item.password)}@${item.ip}:${item.port}`
                    : `${item.ip}:${item.port}:${item.username}:${item.password}`,
                )
                .join("\n")}\n`;
        const ext = args.export_format === "csv" ? "csv" : "txt";
        const path = resolveOutputPath(config.outputDir, args.path, `isp-${args.subscription_id.slice(0, 8)}-proxies.${ext}`);
        await writeOutput(path, content, true);
        return text(`Saved ${proxies.length} ISP proxies to ${path} (mode 600). Keep this file private.`);
      }
      return json({
        proxies: proxies.map((item) => ({ ...item, password: args.reveal_passwords ? item.password : maskSecret(item.password) })),
        total: proxies.length,
      });
    },
  }),
  defineTool({
    name: "isp_rotate",
    toolset: "isp",
    title: "Rotate ISP IPs",
    description:
      "Replace specific ISP IPs with new ones. Uses the subscription's rotation allowance and the old IPs stop working. Poll isp_rotation_status with the returned rotation ID.",
    input: { subscription_id: uuid, ips: z.array(ipv4).min(1).max(100) },
    mutates: true,
    annotations: { destructiveHint: true, idempotentHint: false },
    run: async (args, { client }) => json(await client.ispRotate(args.subscription_id, args.ips)),
  }),
  defineTool({
    name: "isp_rotation_status",
    toolset: "isp",
    title: "ISP rotation status",
    description: "Check a rotation's progress and the replacement IPs.",
    input: { rotation_id: uuid },
    run: async (args, { client }) => json(await client.ispRotationStatus(args.rotation_id)),
  }),
  defineTool({
    name: "isp_get_ip_authorization",
    toolset: "isp",
    title: "Get ISP IP authorization",
    description: "Show which public IPv4 address may use the subscription's proxies without a password.",
    input: { subscription_id: uuid },
    run: async (args, { client }) => json(await client.ispGetAuthorization(args.subscription_id)),
  }),
  defineTool({
    name: "isp_set_ip_authorization",
    toolset: "isp",
    title: "Set ISP IP authorization",
    description: "Allow one public IPv4 address to use the subscription's proxies without a password, or remove it with remove: true.",
    input: { subscription_id: uuid, ip: ipv4.optional(), remove: z.boolean().default(false) },
    mutates: true,
    annotations: { destructiveHint: false, idempotentHint: true },
    run: async (args, { client }) => {
      if (args.remove) return json(await client.ispRemoveAuthorization(args.subscription_id));
      if (!args.ip) throw new Error("Provide ip, or set remove to true.");
      return json(await client.ispSetAuthorization(args.subscription_id, args.ip));
    },
  }),
  defineTool({
    name: "isp_cancel_renewal",
    toolset: "isp",
    title: "Cancel ISP renewal",
    description:
      "Stop an ISP subscription from renewing. Proxies keep working until the current period ends. Set confirm_subscription_id to the same ID to proceed.",
    input: { subscription_id: uuid, confirm_subscription_id: z.string() },
    mutates: true,
    annotations: { destructiveHint: true, idempotentHint: true },
    run: async (args, { client }) => {
      if (args.confirm_subscription_id !== args.subscription_id) throw new Error("confirm_subscription_id must match subscription_id. Nothing changed.");
      return json(await client.ispCancelRenewal(args.subscription_id));
    },
  }),
];
