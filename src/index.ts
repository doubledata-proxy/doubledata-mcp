#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DoubleDataAPIError, DoubleDataClient } from "./client.js";
import { credentialsPath, DASHBOARD_API_KEY_URL, isWellFormedAPIKey, loadConfig, removeStoredAPIKey, storeAPIKey } from "./config.js";
import { maskSecret } from "./proxy.js";
import { createServer, VERSION } from "./server.js";
import { formatUSD } from "./tools/shared.js";

const help = `doubledata-mcp ${VERSION} — MCP server for DoubleData Proxy

Usage:
  doubledata-mcp [serve]   Start the MCP server on stdio (default)
  doubledata-mcp login     Open the dashboard, paste an API key and store it securely
  doubledata-mcp logout    Remove the stored API key
  doubledata-mcp whoami    Show which key is in use and the wallet balance

Environment:
  DOUBLEDATA_API_KEY        Organization API key (overrides the stored key)
  DOUBLEDATA_TOOLSETS       Comma list: account,credentials,proxy,invoices,isp (default all)
  DOUBLEDATA_READ_ONLY      true to hide tools that change anything or use traffic
  DOUBLEDATA_OUTPUT_DIR     Where exports and downloads go (default ./doubledata-exports)
  DOUBLEDATA_PROXY_USERNAME / DOUBLEDATA_PROXY_PASSWORD  Default proxy credential
`;

function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The URL is printed as well, so a missing opener is not fatal.
  }
}

function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stderr.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer.trim());
    });
    muted = true;
  });
}

async function login() {
  process.stderr.write(
    `Create an organization API key (ADMIN role required): ${DASHBOARD_API_KEY_URL}\n` +
      "Team > API key > Create. The key is shown once; copy it and paste it here.\n",
  );
  openBrowser(DASHBOARD_API_KEY_URL);
  const key = await askHidden("API key: ");
  if (!isWellFormedAPIKey(key)) throw new Error("That does not look like a DoubleData API key (dd_live_...).");
  const config = await loadConfig({ ...process.env, DOUBLEDATA_API_KEY: key });
  const balance = await new DoubleDataClient({ apiKey: key, apiUrl: config.apiUrl, userAgent: `doubledata-mcp/${VERSION}` }).getBalance();
  const path = await storeAPIKey(key);
  process.stderr.write(`Key verified (wallet ${formatUSD(balance.balance_cents)}) and saved to ${path} with owner-only permissions.\n`);
}

async function whoami() {
  const config = await loadConfig();
  if (!config.apiKey) {
    process.stderr.write("No API key configured. Run `doubledata-mcp login`.\n");
    process.exitCode = 1;
    return;
  }
  const source = config.apiKeySource === "env" ? "DOUBLEDATA_API_KEY" : credentialsPath();
  const balance = await new DoubleDataClient({ apiKey: config.apiKey, apiUrl: config.apiUrl }).getBalance();
  process.stdout.write(`Key ${maskSecret(config.apiKey)} from ${source}\nAPI ${config.apiUrl}\nWallet balance ${formatUSD(balance.balance_cents)}\n`);
}

async function serve() {
  const config = await loadConfig();
  const { server, tools } = createServer({ config });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `doubledata-mcp ${VERSION} ready: ${tools.length} tools${config.readOnly ? " (read-only)" : ""}${config.apiKey ? "" : " — no API key yet, run `doubledata-mcp login`"}\n`,
  );
}

async function main(argv: string[]) {
  const command = argv[0] ?? "serve";
  switch (command) {
    case "serve":
      return serve();
    case "login":
      return login();
    case "logout":
      await removeStoredAPIKey();
      process.stderr.write("Stored API key removed.\n");
      return;
    case "whoami":
      return whoami();
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(help);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${help}`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof DoubleDataAPIError ? `${error.message} (HTTP ${error.status})` : error instanceof Error ? error.message : String(error);
  process.stderr.write(`doubledata-mcp: ${message}\n`);
  process.exit(1);
});
