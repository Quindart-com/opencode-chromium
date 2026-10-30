import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { parse } from "smol-toml";
import { record } from "../shared/values.ts";
import { atomicJson,processAlive } from "../../native-host/src/runtime-participants.ts";

export const BROWSER_MARKETPLACE = "quindart-browser";
export const BROWSER_PLUGIN = "opencode-browser-plugin@" + BROWSER_MARKETPLACE;
export const BROWSER_SOURCE = "https://github.com/Quindart-com/opencode-chromium.git";
const interval = 6 * 60 * 60 * 1000;
export type CodexCommand = (home: string, args: string[]) => Promise<unknown>;
export const runCodex: CodexCommand = (home, args) => new Promise((resolve, reject) => {
  // Arguments are a fixed internal vocabulary. Never accept commands from a page.
  execFile(process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "codex",
    process.platform === "win32" ? ["/d", "/s", "/c", "codex " + args.join(" ")] : args,
    { windowsHide: true, timeout: 60000, maxBuffer: 65536, env: { ...process.env, CODEX_HOME: home } }, (error, stdout) => {
      if (error) reject(new Error("codex_command_failed"));
      else { try { resolve(JSON.parse(stdout)); } catch { reject(new Error("invalid_codex_response")); } }
    });
});
const read = (file: string) => { try { return record(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { return {}; } };
function atLeast(actual: unknown, expected: string) {
  if (typeof actual !== "string" || !/^\d+\.\d+\.\d+$/.test(actual) || !/^\d+\.\d+\.\d+$/.test(expected)) return false;
  const a = actual.split(".").map(Number), b = expected.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return true;
}
function installedAt(home: string, installedPath: unknown, expected: string) {
  if (typeof installedPath !== "string" || !path.isAbsolute(installedPath)) return null;
  const cache = path.resolve(home, "plugins/cache", BROWSER_MARKETPLACE, "opencode-browser-plugin");
  const relative = path.relative(cache, path.resolve(installedPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const manifest = read(path.join(installedPath, ".codex-plugin/plugin.json"));
  const mcp = record(record(read(path.join(installedPath, ".mcp.json")).mcpServers)["opencode-browser-plugin"]);
  const args = Array.isArray(mcp.args) ? mcp.args : [];
  const localLauncher = mcp.command === "node" && args.includes("--input-type=module") && args.some(arg => typeof arg === "string" && arg.includes("MCP_RUNTIME_SETUP_REQUIRED"));
  return manifest.name === "opencode-browser-plugin" && atLeast(manifest.version, expected) && localLauncher ? String(manifest.version) : null;
}
export function inspectBrowserMarketplace(version: string, home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")) {
  let config;
  try { config = record(parse(fs.readFileSync(path.join(home, "config.toml"), "utf8"))); } catch { return { enabled: false, status: "not_configured" }; }
  const enabled = record(record(config.plugins)[BROWSER_PLUGIN]).enabled === true;
  if (!enabled) return { enabled, status: "not_configured" };
  const source = record(record(config.marketplaces)[BROWSER_MARKETPLACE]);
  if (source.source_type && (source.source_type !== "git" || ![BROWSER_SOURCE, BROWSER_SOURCE.replace(/\.git$/, "")].includes(String(source.source)))) return { enabled, status: "custom_source" };
  if (typeof source.ref === "string" && !["master", "main", "HEAD"].includes(source.ref)) return { enabled, status: "pinned" };
  const cache = path.join(home, "plugins/cache", BROWSER_MARKETPLACE, "opencode-browser-plugin");
  let installedVersion: string | null = null;
  try { for (const entry of fs.readdirSync(cache)) { const found = installedAt(home, path.join(cache, entry), version); if (found && (!installedVersion || atLeast(found, installedVersion))) installedVersion = found; } } catch { /* Missing cache is repairable. */ }
  return { enabled, status: !source.source_type ? "missing_source" : installedVersion ? "installed" : "outdated", installedVersion };
}

/** Refresh and install through Codex only; never edit its caches or restart a harness. */
export async function refreshBrowserMarketplace({ version, dir, home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), run = runCodex, now = Date.now, force = false }: {
  version: string; dir: string; home?: string; run?: CodexCommand; now?: () => number; force?: boolean;
}) {
  const health = inspectBrowserMarketplace(version, home);
  if (!health.enabled || ["custom_source", "pinned"].includes(health.status)) return { status: health.status };
  const marker = path.join(dir, "codex-marketplace-refresh.json"), lock = marker + ".lock", previous = read(marker), time = now();
  if (!force && previous.version === version) {
    if (health.status === "installed" && typeof previous.checkedAt === "number" && time - previous.checkedAt >= 0 && time - previous.checkedAt < interval) return { status: "current", installedVersion: health.installedVersion };
    if (typeof previous.retryAt === "number" && previous.retryAt > time) return { status: "retry", retryAt: previous.retryAt };
  }
  fs.mkdirSync(dir, { recursive: true });
  try { const owner = read(lock); if (typeof owner.pid === "number" && !processAlive(owner.pid)) fs.unlinkSync(lock); } catch { /* Another writer may be creating it. */ }
  let handle: number;
  try { handle = fs.openSync(lock, "wx", 0o600); fs.writeFileSync(handle, JSON.stringify({ pid: process.pid })); } catch { return { status: "pending" }; }
  try {
    if (health.status === "missing_source") {
      try { await run(home, ["plugin", "marketplace", "add", BROWSER_SOURCE, "--ref", "master", "--json"]); }
      catch {
        // Codex can retain a stale source snapshot after its configuration is lost.
        // Only the enabled browser plugin's absent source is replaced.
        await run(home, ["plugin", "marketplace", "remove", BROWSER_MARKETPLACE, "--json"]);
        await run(home, ["plugin", "marketplace", "add", BROWSER_SOURCE, "--ref", "master", "--json"]);
      }
    }
    await run(home, ["plugin", "marketplace", "upgrade", BROWSER_MARKETPLACE, "--json"]);
    const installed = record(await run(home, ["plugin", "add", BROWSER_PLUGIN, "--json"]));
    const installedVersion = installedAt(home, installed.installedPath, version);
    if (!installedVersion || !atLeast(installed.version, version)) throw new Error("installed_plugin_not_verified");
    atomicJson(marker, { version, checkedAt: time, installedVersion });
    return { status: "refreshed", installedVersion };
  } catch {
    atomicJson(marker, { version, retryAt: time + 5 * 60 * 1000, status: "retry" });
    return { status: "retry", retryAt: time + 5 * 60 * 1000 };
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}
