import { z } from "zod";
import { resolveOutputPath, toCSV, writeOutput } from "../files.js";
import { defineTool, formatBytes, formatUSD, json, text } from "./shared.js";

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

const usageRange = {
  from: dateString.optional().describe("Inclusive UTC start date (YYYY-MM-DD). Defaults to the current UTC month."),
  to: dateString.optional().describe("Exclusive UTC end date (YYYY-MM-DD). Must be 1 to 366 days after from."),
  username: z.string().optional().describe("Limit the report to one proxy credential username."),
};

function rangeArgs(args: { from?: string; to?: string; username?: string }) {
  if (Boolean(args.from) !== Boolean(args.to)) throw new Error("Provide both from and to, or neither.");
  return { from: args.from, to: args.to, username: args.username };
}

export const accountTools = [
  defineTool({
    name: "account_overview",
    toolset: "account",
    title: "Account overview",
    description:
      "One-call summary of the DoubleData account: wallet balance, this month's bandwidth/requests/spend, top credentials by traffic, credential count, active ISP subscriptions and open invoices. Use first when the user asks what they have, how much they used, or how much is left.",
    input: {},
    run: async (_args, { client, config }) => {
      const settled = await Promise.allSettled([
        client.getBalance(),
        client.getUsage(),
        config.toolsets.has("credentials") ? client.listCredentials() : Promise.resolve(null),
        config.toolsets.has("isp") ? client.ispSubscriptions() : Promise.resolve(null),
        config.toolsets.has("invoices") ? client.listInvoices({ status: "open", limit: 100 }) : Promise.resolve(null),
      ]);
      const [balance, usage, credentials, subscriptions, openInvoices] = settled.map((item) => (item.status === "fulfilled" ? item.value : null)) as [
        Awaited<ReturnType<typeof client.getBalance>> | null,
        Awaited<ReturnType<typeof client.getUsage>> | null,
        Awaited<ReturnType<typeof client.listCredentials>> | null,
        Awaited<ReturnType<typeof client.ispSubscriptions>> | null,
        Awaited<ReturnType<typeof client.listInvoices>> | null,
      ];
      const failures = settled.flatMap((item, index) =>
        item.status === "rejected" ? [`${["balance", "usage", "credentials", "isp", "invoices"][index]}: ${(item.reason as Error).message}`] : [],
      );
      if (!balance && !usage) throw (settled[0] as PromiseRejectedResult).reason;
      const lines: string[] = ["# DoubleData account overview"];
      if (balance) lines.push(`- Wallet balance: ${formatUSD(balance.balance_cents)}`);
      if (usage) {
        lines.push(
          `- Usage ${usage.from} → ${usage.to}: ${formatBytes(usage.totals.bandwidth_bytes)}, ${usage.totals.requests.toLocaleString("en-US")} requests, ${formatUSD(usage.totals.wallet_spent_cents)} charged to wallet`,
        );
        const top = [...usage.credentials].sort((a, b) => b.bandwidth_bytes - a.bandwidth_bytes).slice(0, 5).filter((item) => item.bandwidth_bytes > 0);
        for (const item of top) {
          lines.push(`  - ${item.display_name || item.username} (${item.proxy_type}, ${item.username}): ${formatBytes(item.bandwidth_bytes)}, ${item.requests} requests`);
        }
      }
      if (credentials) {
        const enabled = credentials.credentials.filter((item) => item.enabled).length;
        lines.push(`- Proxy credentials: ${credentials.total} (${enabled} enabled)`);
      }
      if (subscriptions) lines.push(`- Active ISP subscriptions: ${subscriptions.subscriptions.length}`);
      if (openInvoices) {
        const due = openInvoices.invoices.reduce((sum, item) => sum + item.amount_due_cents, 0);
        lines.push(`- Open invoices: ${openInvoices.invoices.length}${openInvoices.invoices.length ? ` (${formatUSD(due)} due)` : ""}`);
      }
      if (failures.length) lines.push("", "Partially unavailable:", ...failures.map((item) => `- ${item}`));
      return text(lines.join("\n"));
    },
  }),
  defineTool({
    name: "get_balance",
    toolset: "account",
    title: "Get wallet balance",
    description: "Return the organization's prepaid wallet balance in USD cents. Package GB balances are reflected in usage and credential funding.",
    input: {},
    run: async (_args, { client }) => {
      const balance = await client.getBalance();
      return json(balance, `Wallet balance: ${formatUSD(balance.balance_cents)}`);
    },
  }),
  defineTool({
    name: "get_usage",
    toolset: "account",
    title: "Get bandwidth usage",
    description:
      "Bandwidth bytes, request counts and wallet charges for a UTC date range, in total and per credential. Defaults to the current month. Use username to focus on one credential.",
    input: usageRange,
    run: async (args, { client }) => {
      const usage = await client.getUsage(rangeArgs(args));
      return json(
        usage,
        `Usage ${usage.from} → ${usage.to}: ${formatBytes(usage.totals.bandwidth_bytes)}, ${usage.totals.requests} requests, ${formatUSD(usage.totals.wallet_spent_cents)} wallet spend.`,
      );
    },
  }),
  defineTool({
    name: "export_usage",
    toolset: "account",
    title: "Export usage report",
    description:
      "Download a per-credential usage report as CSV or JSON into the local export directory. Use when the user wants a file, spreadsheet or report of their traffic.",
    input: {
      ...usageRange,
      format: z.enum(["csv", "json"]).default("csv"),
      path: z.string().optional().describe("Relative file path inside the export directory."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (args, { client, config, now }) => {
      const usage = await client.getUsage(rangeArgs(args));
      const name = `usage-${usage.from}-to-${usage.to}.${args.format}`;
      const path = resolveOutputPath(config.outputDir, args.path, name);
      const content =
        args.format === "json"
          ? `${JSON.stringify({ exported_at: now().toISOString(), ...usage }, null, 2)}\n`
          : toCSV(
              ["username", "display_name", "proxy_type", "enabled", "bandwidth_bytes", "bandwidth_gb", "requests", "wallet_spent_usd"],
              usage.credentials.map((item) => [
                item.username,
                item.display_name,
                item.proxy_type,
                item.enabled,
                item.bandwidth_bytes,
                (item.bandwidth_bytes / 1e9).toFixed(4),
                item.requests,
                (item.wallet_spent_cents / 100).toFixed(2),
              ]),
            );
      await writeOutput(path, content);
      return text(`Saved ${usage.credentials.length} credential rows (${usage.from} → ${usage.to}) to ${path}`);
    },
  }),
];

