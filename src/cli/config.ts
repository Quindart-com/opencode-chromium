import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigOptions,HarnessId } from "../management/configuration.ts";
import { planConfiguration } from "../management/configuration.ts";
import { applyTransaction } from "../management/transaction.ts";
export const CANONICAL_SERVER = "opencode-browser-plugin";
export const CORE_TOOLS = ["browser_run", "browser_observe", "browser_session", "browser_finalize"];

function home() {
  return os.homedir();
}

export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function configPath(client: HarnessId, explicit?: string) {
  if (explicit) return path.resolve(explicit);
  if (client === "dsh") return path.join(process.env.DSH_HOME ?? path.join(home(), ".dsh"), "profiles", "web", "cordis.patch.yml");
  if (client === "claude-code") return path.join(process.env.CLAUDE_CONFIG_DIR ?? home(), ".claude.json");
  if (client === "claude-desktop") return path.join(process.platform === "win32" ? process.env.APPDATA ?? path.join(home(), "AppData", "Roaming") : path.join(home(), "Library", "Application Support"), "Claude", "claude_desktop_config.json");
  if (client === "codex") return path.join(process.env.CODEX_HOME ?? path.join(home(), ".codex"), "config.toml");
  // OpenCode's Windows global config follows its XDG-style location, not the
  // generic %APPDATA% application-data location.
  if (process.platform === "win32") return path.join(home(), ".config", "opencode", "opencode.json");
  return path.join(home(), ".config", "opencode", "opencode.json");
}

export function backup(filePath: fs.PathLike, { now = new Date() } = {}) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const base = `${filePath}.bak-${stamp}`;
  let target = base;
  let suffix = 0;
  while (fs.existsSync(target)) target = `${base}-${++suffix}`;
  fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
  return target;
}

function tomlSection(name: string, body: string[]) {
  return `[mcp_servers.${name}]\n${body.map(line => `${line}\n`).join("")}`;
}

export function codexServerToml(serverPath: string) {
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

export function updateClientConfig({ client, filePath, action = "install", serverPath = "", dryRun = false, version, interpreter }: Omit<ConfigOptions, "serverPath"> & { filePath?: string; serverPath?: string; dryRun?: boolean }) {
  const target = configPath(client, filePath);
  const existed = fs.existsSync(target);
  const before = existed ? fs.readFileSync(target, "utf8") : "";
  const after = planConfiguration(before, { client, serverPath, action, version, interpreter });
  const result = applyTransaction([{ filePath: target, before: existed ? before : null, after }], dryRun);
  return { client, action, filePath: target, changed: before !== after, dryRun, backup: result.backups[0] ?? null, before, after };
}
