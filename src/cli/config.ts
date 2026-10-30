import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConfigOptions,HarnessId } from "../management/configuration.ts";
import { planConfiguration } from "../management/configuration.ts";
import { harnessConfigPath } from "../management/harness-paths.ts";
import { applyTransaction } from "../management/transaction.ts";
export const CANONICAL_SERVER = "opencode-browser-plugin";
export const CORE_TOOLS = ["browser_run", "browser_observe", "browser_session", "browser_finalize"];

export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function configPath(client: HarnessId, explicit?: string) {
  if (explicit) return path.resolve(explicit);
  return harnessConfigPath(client);
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
