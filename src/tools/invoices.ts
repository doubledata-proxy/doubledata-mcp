import { z } from "zod";
import { resolveOutputPath, safeFilename, toCSV, writeOutput } from "../files.js";
import type { Invoice } from "../client.js";
import { defineTool, formatUSD, json, text } from "./shared.js";

const invoiceId = z.string().regex(/^in_[A-Za-z0-9]{1,255}$/, "Invoice IDs look like in_1Pabc...");
const invoiceStatus = z.enum(["open", "paid", "void", "uncollectible"]);

function invoiceSummary(invoice: Invoice) {
  return `${invoice.number ?? invoice.id} · ${invoice.created_at.slice(0, 10)} · ${invoice.status} · ${formatUSD(invoice.total_cents)}${
    invoice.amount_due_cents > 0 ? ` (${formatUSD(invoice.amount_due_cents)} due)` : ""
  }`;
}

export const invoiceTools = [
  defineTool({
    name: "list_invoices",
    toolset: "invoices",
    title: "List invoices",
    description:
      "List the organization's invoices newest first with number, status, totals, amount due and a hosted payment link. Paginate with starting_after (the next_cursor of the previous page).",
    input: {
      status: invoiceStatus.optional(),
      limit: z.number().int().min(1).max(100).default(25),
      starting_after: invoiceId.optional(),
    },
    run: async (args, { client }) => {
      const page = await client.listInvoices({ status: args.status, limit: args.limit, starting_after: args.starting_after });
      const lines = page.invoices.map((invoice) => `- ${invoiceSummary(invoice)}`);
      return json(page, lines.length ? `${page.invoices.length} invoice(s):\n${lines.join("\n")}` : "No invoices found.");
    },
  }),
  defineTool({
    name: "get_invoice",
    toolset: "invoices",
    title: "Get invoice",
    description: "Return one invoice by ID with totals, status, dates and hosted invoice link.",
    input: { invoice_id: invoiceId },
    run: async (args, { client }) => json(await client.getInvoice(args.invoice_id)),
  }),
  defineTool({
    name: "download_invoice",
    toolset: "invoices",
    title: "Download invoice PDF",
    description: "Save an invoice PDF into the local export directory and return the file path.",
    input: {
      invoice_id: invoiceId,
      path: z.string().optional().describe("Relative file path inside the export directory. Defaults to invoices/<number>.pdf."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (args, { client, config }) => {
      const file = await client.downloadInvoicePDF(args.invoice_id);
      const path = resolveOutputPath(config.outputDir, args.path ?? `invoices/${safeFilename(file.filename)}`, file.filename);
      await writeOutput(path, file.bytes);
      return text(`Saved ${file.filename} (${file.bytes.byteLength} bytes) to ${path}`);
    },
  }),
  defineTool({
    name: "download_all_invoices",
    toolset: "invoices",
    title: "Download all invoices",
    description:
      "Download every invoice PDF (optionally filtered by status or a since date) into invoices/ in the export directory, plus an invoices.csv index. Use for bookkeeping and accounting exports.",
    input: {
      status: invoiceStatus.optional(),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only invoices created on or after this UTC date."),
      max_invoices: z.number().int().min(1).max(500).default(200),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (args, { client, config }) => {
      const selected: Invoice[] = [];
      let cursor: string | undefined;
      collect: for (;;) {
        const page = await client.listInvoices({ status: args.status, limit: 100, starting_after: cursor });
        for (const invoice of page.invoices) {
          if (args.since && invoice.created_at.slice(0, 10) < args.since) break collect;
          selected.push(invoice);
          if (selected.length >= args.max_invoices) break collect;
        }
        if (!page.has_more || !page.next_cursor) break;
        cursor = page.next_cursor;
      }
      const saved: string[] = [];
      const skipped: string[] = [];
      for (const invoice of selected) {
        if (!invoice.pdf_available) {
          skipped.push(`${invoice.number ?? invoice.id}: no PDF yet`);
          continue;
        }
        try {
          const file = await client.downloadInvoicePDF(invoice.id);
          const path = resolveOutputPath(config.outputDir, `invoices/${safeFilename(file.filename)}`, file.filename);
          await writeOutput(path, file.bytes);
          saved.push(path);
        } catch (error) {
          skipped.push(`${invoice.number ?? invoice.id}: ${(error as Error).message}`);
        }
      }
      const indexPath = resolveOutputPath(config.outputDir, "invoices/invoices.csv", "invoices.csv");
      await writeOutput(
        indexPath,
        toCSV(
          ["id", "number", "status", "created_at", "paid_at", "currency", "total", "amount_paid", "amount_due", "hosted_invoice_url"],
          selected.map((item) => [
            item.id,
            item.number,
            item.status,
            item.created_at,
            item.paid_at,
            item.currency,
            (item.total_cents / 100).toFixed(2),
            (item.amount_paid_cents / 100).toFixed(2),
            (item.amount_due_cents / 100).toFixed(2),
            item.hosted_invoice_url,
          ]),
        ),
      );
      const lines = [`Downloaded ${saved.length} of ${selected.length} invoice PDF(s). Index: ${indexPath}`];
      if (skipped.length) lines.push("Skipped:", ...skipped.map((item) => `- ${item}`));
      return text(lines.join("\n"));
    },
  }),
];
