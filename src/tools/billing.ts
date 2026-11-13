import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DoubleDataAPIError } from "../client.js";
import { defineTool, formatBytes, formatUSD, json } from "./shared.js";

const uuid = z.string().uuid();
const requestId = uuid
  .optional()
  .describe("Optional. Reuse the request_id from a failed or timed-out attempt to retry it without paying twice.");

// A charge whose response was lost may still have gone through; the caller needs the
// request ID to retry it safely.
async function withRequestId<T>(id: string, run: (id: string) => Promise<T>) {
  try {
    return await run(id);
  } catch (error) {
    if (error instanceof DoubleDataAPIError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\nThe result is unknown. Check get_balance, or retry with request_id ${id}; a retry with the same request_id is never charged twice.`);
  }
}

export const billingTools = [
  defineTool({
    name: "traffic_products",
    toolset: "billing",
    title: "Traffic packages",
    description:
      "List traffic packages (GB of residential, datacenter, ISP or mobile traffic) with prices. Packages marked requires_verification need a verified organization.",
    input: {},
    run: async (_args, { client }) => json(await client.listTrafficProducts()),
  }),
  defineTool({
    name: "buy_traffic",
    toolset: "billing",
    title: "Buy a traffic package",
    description:
      "Buy a traffic package from the organization balance. This spends balance. Show the package and price and get the user's explicit approval first, then set confirm_purchase to true. If the balance is too low, use add_funds first (with the user's approval).",
    input: {
      product_id: uuid,
      confirm_purchase: z.literal(true).describe("Must be true; confirms the user approved the charge."),
      request_id: requestId,
    },
    mutates: true,
    annotations: { destructiveHint: true, idempotentHint: true },
    run: async (args, { client }) =>
      withRequestId(args.request_id ?? randomUUID(), async (id) => {
        const result = await client.buyTraffic(args.product_id, id);
        const { order } = result;
        return json(
          { ...result, request_id: id },
          `Bought ${order.amount_gb} GB of ${order.proxy_type} traffic for ${formatUSD(order.total_cents)} from the balance. ${order.proxy_type} traffic left: ${formatBytes(result.traffic_balance.remaining_bytes)}.`,
        );
      }),
  }),
  defineTool({
    name: "list_payment_methods",
    toolset: "billing",
    title: "Saved payment methods",
    description: "List the organization's saved payment methods (brand, last 4 digits, expiry, default).",
    input: {},
    run: async (_args, { client }) => json(await client.listPaymentMethods()),
  }),
  defineTool({
    name: "add_funds",
    toolset: "billing",
    title: "Add funds from a saved card",
    description:
      "Charge a saved payment method and add the amount to the organization balance ($10 to $1,000 per call). This charges the user's card. State the amount and card (list_payment_methods) and get the user's explicit approval first, then set confirm_charge to true. Uses the default card unless payment_method_id is given. Cards that need authentication are declined; the user then adds funds on the website.",
    input: {
      amount_usd: z.number().min(10).max(1000).multipleOf(0.01).describe("Amount in US dollars, 10 to 1000."),
      payment_method_id: uuid.optional(),
      confirm_charge: z.literal(true).describe("Must be true; confirms the user approved charging the card."),
      request_id: requestId,
    },
    mutates: true,
    annotations: { destructiveHint: true, idempotentHint: true },
    run: async (args, { client }) =>
      withRequestId(args.request_id ?? randomUUID(), async (id) => {
        const result = await client.addFunds(
          { amount_cents: Math.round(args.amount_usd * 100), ...(args.payment_method_id ? { payment_method_id: args.payment_method_id } : {}) },
          id,
        );
        const balance = result.balance_cents === null ? "" : ` Balance is now ${formatUSD(result.balance_cents)}.`;
        return json({ ...result, request_id: id }, `Charged ${formatUSD(result.top_up.amount_cents)} to the saved card.${balance}`);
      }),
  }),
];
