import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export function safeFilename(name: string) {
  const cleaned = basename(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned || "download";
}

// Exports stay inside the configured output directory so a tool argument
// cannot overwrite arbitrary files such as shell profiles or SSH keys.
export function resolveOutputPath(outputDir: string, requested: string | undefined, fallbackName: string) {
  const root = resolve(outputDir);
  const target = requested ? resolve(root, requested) : resolve(root, safeFilename(fallbackName));
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Output paths must stay inside ${root}. Set DOUBLEDATA_OUTPUT_DIR to change it.`);
  }
  return target;
}

export async function writeOutput(path: string, data: string | Uint8Array, secret = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data, { mode: secret ? 0o600 : 0o644 });
  return path;
}

export function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  // Leading formula characters are neutralized so spreadsheets do not execute them.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCSV(headers: string[], rows: unknown[][]) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}
