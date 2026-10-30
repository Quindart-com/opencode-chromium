import { applyEdits,modify,parse,type ParseError } from "jsonc-parser";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath,pathToFileURL } from "node:url";
import { parse as parseToml,stringify as stringifyToml } from "smol-toml";
import { record } from "../shared/values.ts";
import { deepSeekManaged,planDeepSeek } from "./deepseek.ts";

export const SERVER_ID = "opencode-browser-plugin";
import type { HarnessId } from "../shared/harnesses.ts";
export type { HarnessId };
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
  // The managed V2 directory and legacy file launcher represent the same plugin.
  if (expected && path.basename(expected) === "plugin.mjs" && path.resolve(resolved) === path.join(path.dirname(path.resolve(expected)), "v2")) return true;
  try {
    return record(JSON.parse(fs.readFileSync(path.join(resolved, "package.json"), "utf8")) as unknown).name === "opencode-chromium";
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
export function nativeCodexPluginEnabled(before: string): boolean {
  const plugins = object(parseToml(before).plugins);
  return Object.entries(plugins).some(([name, settings]) =>
    name.startsWith(`${SERVER_ID}@`) && object(settings).enabled === true);
}

export function managedConfiguration(before: string, client: HarnessId, serverPath = ""): boolean {
  try {
    if (client === "dsh") return deepSeekManaged(before);
    if (client === "codex") return nativeCodexPluginEnabled(before) || object(parseToml(before).mcp_servers)[SERVER_ID] !== undefined;
    const config = jsonConfig(before);
    if (client.startsWith("claude")) return object(config.mcpServers)[SERVER_ID] !== undefined;
    const plugins = [...(Array.isArray(config.plugin) ? config.plugin : []), ...(Array.isArray(config.plugins) ? config.plugins : [])];
    const mcp = object(config.mcp);
    return plugins.some(entry => ownPlugin(entry, serverPath)) || mcp[SERVER_ID] !== undefined || object(mcp.servers)[SERVER_ID] !== undefined;
  } catch { return false; }
}

/** Locate tables without treating a header inside a multiline TOML value as one. */
function codexTables(before: string): Array<{ start: number; end: number; owned: boolean }> {
  const headers: Array<{ start: number; owned: boolean }> = [];
  for (const match of before.matchAll(/^[ \t]*\[[^\r\n]*\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/gm)) {
    try {
      parseToml(before.slice(0, match.index));
      const table = parseToml(match[0]);
      const servers = table.mcp_servers;
      headers.push({ start: match.index, owned: Boolean(servers && typeof servers === "object" && SERVER_ID in servers) });
    } catch { /* incomplete multiline values are not table boundaries */ }
  }
  return headers.map((header, index) => ({ ...header, end: headers[index + 1]?.start ?? before.length }));
}

function codexConfig(before: string, options: ConfigOptions): string {
  const parsed = parseToml(before);
  const existing = object(object(parsed.mcp_servers)[SERVER_ID]);
  const owned = codexTables(before).filter(table => table.owned);
  const removing = options.action === "uninstall" || nativeCodexPluginEnabled(before);
  if (removing) {
    if (!owned.length && Object.keys(existing).length) throw new Error("Inline Codex browser settings require manual removal; no files changed");
    return owned.reverse().reduce((text, table) => text.slice(0, table.start) + text.slice(table.end), before);
  }
  const fields = { ...existing, command: options.interpreter ?? process.execPath,
    args: [options.serverPath], startup_timeout_sec: existing.startup_timeout_sec ?? 20,
    tool_timeout_sec: existing.tool_timeout_sec ?? 120 };
  if (owned.length && existing.command === fields.command && JSON.stringify(existing.args) === JSON.stringify(fields.args)) return before;
  if (!owned.length && Object.keys(existing).length) throw new Error("Inline Codex browser settings require manual migration; no files changed");
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const block = stringifyToml({ mcp_servers: { [SERVER_ID]: fields } }).replaceAll("\n", eol);
  const first = owned[0];
  const after = first ? owned.reverse().reduce((text, table) =>
    text.slice(0, table.start) + (table.start === first.start ? block : "") + text.slice(table.end), before) :
    `${before}${before && !before.endsWith("\n") ? eol : ""}${block}`;
  parseToml(after);
  return after;
}

/** Pure, validated planning. JSONC edits preserve unrelated bytes and comments. */
export function planConfiguration(before: string, options: ConfigOptions): string {
  if (options.client === "dsh") return planDeepSeek(before, options.serverPath, options.interpreter ?? process.execPath, options.action === "uninstall");
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
  if (installing && options.client === "opencode") plugins.push(pathToFileURL(path.resolve(major >= 2 && path.basename(options.serverPath) === "plugin.mjs" ? path.join(path.dirname(options.serverPath), "v2") : options.serverPath)).href);
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
