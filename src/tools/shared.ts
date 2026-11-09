import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape, z } from "zod";
import { DoubleDataAPIError, MissingAPIKeyError, type DoubleDataClient } from "../client.js";
import type { Config, Toolset } from "../config.js";
import type { ProxyRequester } from "../proxy.js";

export type ToolContext = {
  client: DoubleDataClient;
  config: Config;
  sendThroughProxy: ProxyRequester;
  now: () => Date;
};

type ToolSpec<Shape extends ZodRawShape> = {
  name: string;
  toolset: Toolset;
  title: string;
  description: string;
  input: Shape;
  // Mutating tools are hidden in read-only mode.
  mutates?: boolean;
  annotations?: Omit<ToolAnnotations, "title">;
  run: (args: z.output<z.ZodObject<Shape>>, context: ToolContext) => Promise<CallToolResult | unknown>;
};

export function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

export function json(value: unknown, summary?: string): CallToolResult {
  const body = JSON.stringify(value, null, 2);
  return text(summary ? `${summary}\n\n${body}` : body);
}

export function errorResult(error: unknown): CallToolResult {
  let message: string;
  if (error instanceof DoubleDataAPIError) {
    const parts = [`DoubleData API error ${error.status} (${error.code}): ${error.message}`];
    if (error.details) parts.push(`Details: ${JSON.stringify(error.details)}`);
    if (error.retryAfterSeconds) parts.push(`Retry after ${error.retryAfterSeconds} seconds.`);
    if (error.requestId) parts.push(`Request ID: ${error.requestId}`);
    message = parts.join("\n");
  } else if (error instanceof MissingAPIKeyError) {
    message = error.message;
  } else {
    message = error instanceof Error ? error.message : String(error);
  }
  return { isError: true, content: [{ type: "text", text: message }] };
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return typeof value === "object" && value !== null && Array.isArray((value as CallToolResult).content);
}

export function defineTool<Shape extends ZodRawShape>(spec: ToolSpec<Shape>) {
  return spec as unknown as ToolSpec<ZodRawShape>;
}

export type AnyTool = ReturnType<typeof defineTool>;

export function registerTools(server: McpServer, tools: AnyTool[], context: ToolContext) {
  const registered: string[] = [];
  for (const tool of tools) {
    if (!context.config.toolsets.has(tool.toolset)) continue;
    if (tool.mutates && context.config.readOnly) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: !tool.mutates,
          openWorldHint: true,
          ...tool.annotations,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.run(args as never, context);
          return isCallToolResult(result) ? result : json(result);
        } catch (error) {
          return errorResult(error);
        }
      },
    );
    registered.push(tool.name);
  }
  return registered;
}

export function formatBytes(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function formatUSD(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}
