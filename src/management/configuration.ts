import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

export const SERVER_ID = "opencode-browser-plugin";
export type HarnessId = "codex" | "opencode" | "opencode-mcp" | "claude-code" | "claude-desktop";
export interface ConfigOptions {
  client: HarnessId;
  serverPath: string;
  action?: "install" | "uninstall";
  version?: string;
  interpreter?: string;
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must contain objects");
  return value as ObjectValue;
}
function ownPlugin(entry: unknown, expected: string): boolean {
  const raw = typeof entry === "string" ? entry : typeof entry === "object" && entry !== null ? Reflect.get(entry, "package") : undefined;
  if (typeof raw !== "string") return false;
  if (/^(?:opencode-chromium|opencode-browser-plugin)(?:@[^/]+)?$/.test(raw)) return true;
  let resolved = raw;
  try { if (raw.startsWith("file:")) resolved = fileURLToPath(raw); } catch { return false; }
  if (expected && path.resolve(resolved) === path.resolve(expected)) return true;
  try {
    return JSON.parse(fs.readFileSync(path.join(resolved, "package.json"), "utf8")).name === "opencode-chromium";
  } catch { return false; }
}
function jsonConfig(before: string): ObjectValue {
  const errors: ParseError[] = [];
  const value: unknown = parse(before.trim() ? before : "{}", errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("Invalid JSON/JSONC configuration; no files changed");
  return object(value);
}
function set(text: string, keys: string[], value: unknown): string {
  return applyEdits(text.trim() ? text : "{}\n", modify(text.trim() ? text : "{}\n", keys, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
  }));
}
function codexConfig(before: string, options: ConfigOptions): string {
  const parsed = parseToml(before);
  const existing = object(object(parsed.mcp_servers)[SERVER_ID]);
  const fields = { ...existing, command: options.interpreter ?? process.execPath,
    args: [options.serverPath], startup_timeout_sec: existing.startup_timeout_sec ?? 20,
    tool_timeout_sec: existing.tool_timeout_sec ?? 120 };
  const block = `[mcp_servers.${SERVER_ID}]\n${Object.entries(fields).map(([key, value]) => {
    if (!/^[\w-]+$/.test(key) || (value !== null && typeof value === "object" && !Array.isArray(value))) {
      throw new Error("Complex existing MCP settings require manual migration; no files changed");
    }
    return `${key} = ${JSON.stringify(value)}`;
  }).join("\n")}\n`;
  const expression = /(^|\n)\[mcp_servers\.opencode-browser-plugin\][^\n]*\n[\s\S]*?(?=\n\[|$)/;
  const current = before.match(expression);
  if (options.action === "uninstall") return current ? before.replace(expression, "$1") : before;
  if (current && existing.command === fields.command && JSON.stringify(existing.args) === JSON.stringify(fields.args)) return before;
  const after = current ? before.replace(expression, `${current[1]}${block}`) : `${before}${before && !before.endsWith("\n") ? "\n" : ""}${block}`;
  parseToml(after);
  return after;
}

/** Pure, validated planning. JSONC edits preserve unrelated bytes and comments. */
export function planConfiguration(before: string, options: ConfigOptions): string {
  if (options.client === "codex") return codexConfig(before, options);
  const config = jsonConfig(before);
  let after = before;
  const installing = options.action !== "uninstall";
  if (options.client.startsWith("claude")) {
    object(config.mcpServers);
    return set(after, ["mcpServers", SERVER_ID], installing ? {
      command: options.interpreter ?? process.execPath, args: [options.serverPath],
    } : undefined);
  }
  const major = Number.parseInt(options.version ?? "1", 10);
  const key = major >= 2 ? "plugins" : "plugin";
  const otherKey = key === "plugins" ? "plugin" : "plugins";
  for (const name of [key, otherKey]) if (config[name] !== undefined && !Array.isArray(config[name])) throw new Error(`Invalid ${name} array`);
  const plugins = [...(config[key] as unknown[] ?? []), ...(config[otherKey] as unknown[] ?? [])]
    .filter(entry => !ownPlugin(entry, options.serverPath));
  if (installing && options.client === "opencode") plugins.push(pathToFileURL(path.resolve(options.serverPath)).href);
  after = set(after, [key], plugins);
  if (config[otherKey] !== undefined) after = set(after, [otherKey], undefined);
  const mcp = object(config.mcp);
  if (mcp.servers !== undefined) {
    const legacy = object(mcp.servers);
    if (legacy[SERVER_ID] !== undefined) {
      after = set(after, ["mcp", "servers", SERVER_ID], undefined);
      if (Object.keys(legacy).length === 1) after = set(after, ["mcp", "servers"], undefined);
    }
  }
  if (mcp[SERVER_ID] !== undefined || options.client === "opencode-mcp") {
    after = set(after, ["mcp", SERVER_ID], installing && options.client === "opencode-mcp" ? {
      type: "local", command: [options.interpreter ?? process.execPath, options.serverPath], timeout: 120000,
    } : undefined);
  }
  jsonConfig(after);
  return after;
}
