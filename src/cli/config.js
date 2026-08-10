import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANONICAL_SERVER = "opencode-browser-plugin";
export const CORE_TOOLS = ["browser_run", "browser_observe", "browser_session", "browser_finalize"];

function home() {
  return os.homedir();
}

export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function configPath(client, explicit) {
  if (explicit) return path.resolve(explicit);
  if (client === "codex") return path.join(process.env.CODEX_HOME ?? path.join(home(), ".codex"), "config.toml");
  // OpenCode's Windows global config follows its XDG-style location, not the
  // generic %APPDATA% application-data location.
  if (process.platform === "win32") return path.join(home(), ".config", "opencode", "opencode.json");
  return path.join(home(), ".config", "opencode", "opencode.json");
}

export function backup(filePath, { now = new Date() } = {}) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const base = `${filePath}.bak-${stamp}`;
  let target = base;
  let suffix = 0;
  while (fs.existsSync(target)) target = `${base}-${++suffix}`;
  fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
  return target;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(filePath, value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function tomlSection(name, body) {
  return `[mcp_servers.${name}]\n${body.map((line) => `${line}\n`).join("")}`;
}

function removeTomlSection(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?:^|\\n)\\[mcp_servers\\.${escaped}\\][\\s\\S]*?(?=\\n\\[[^\\n]+\\]|$)`, "g"), "\n").replace(/^\s*\n/, "");
}

export function codexServerToml(serverPath) {
  return tomlSection(CANONICAL_SERVER, [
    `command = "bun"`,
    `args = [${JSON.stringify(serverPath)}]`,
    "required = true",
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 120",
    `enabled_tools = [${CORE_TOOLS.map((tool) => JSON.stringify(tool)).join(", ")}]`,
    `default_tools_approval_mode = "writes"`,
  ]);
}

export function updateClientConfig({ client, filePath, action = "install", serverPath, dryRun = false } = {}) {
  const target = configPath(client, filePath);
  const before = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  let after = before;
  if (client === "codex") {
    after = removeTomlSection(before, CANONICAL_SERVER);
    if (action !== "uninstall") after = `${after.trimEnd()}${after.trim() ? "\n\n" : ""}${codexServerToml(serverPath)}\n`;
  } else {
    const config = readJson(target);
    const resolvedServerPath = serverPath ? path.resolve(serverPath) : "";
    const pluginEntry = resolvedServerPath ? pathToFileURL(resolvedServerPath).href : "";
    const legacyPluginEntry = resolvedServerPath ? `file://${resolvedServerPath.replaceAll("\\", "/")}` : "";
    const localEntries = new Set([pluginEntry, legacyPluginEntry].filter(Boolean));
    const configuredPlugins = [
      ...(Array.isArray(config.plugin) ? config.plugin : []),
      ...(Array.isArray(config.plugins) ? config.plugins : []),
    ].filter((entry) => !localEntries.has(String(entry)) && !String(entry).includes(CANONICAL_SERVER));
    config.plugin = configuredPlugins;
    // `plugin` is OpenCode's official schema key. Remove the plural alias if
    // an earlier installer version left it behind, otherwise OpenCode rejects
    // the whole configuration as invalid.
    delete config.plugins;
    if (action !== "uninstall" && client !== "opencode-mcp") config.plugin.push(pluginEntry);
    if (client === "opencode-mcp") {
      config.mcp ??= {};
      config.mcp.servers ??= {};
      delete config.mcp.servers[CANONICAL_SERVER];
      if (action !== "uninstall") config.mcp.servers[CANONICAL_SERVER] = { type: "local", command: ["bun", serverPath], codemode: false, timeout: 120000 };
    } else if (config.mcp?.servers && typeof config.mcp.servers === "object" && !Array.isArray(config.mcp.servers)) {
      // Clean up the empty legacy container created by older releases. Native
      // OpenCode MCP entries live directly under `mcp`, not under `mcp.servers`.
      delete config.mcp.servers[CANONICAL_SERVER];
      if (Object.keys(config.mcp.servers).length === 0) delete config.mcp.servers;
    }
    after = writeJson(target, config);
  }
  const changed = before !== after;
  let backupPath = null;
  if (changed && !dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    backupPath = backup(target);
    fs.writeFileSync(target, after, "utf8");
  }
  return { client, action, filePath: target, changed, dryRun, backup: backupPath, before, after };
}
