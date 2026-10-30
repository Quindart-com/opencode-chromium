#!/usr/bin/env node
// Built-ins only: usable from the skill even when MCP dependencies are broken.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const requiredTools = ["browser_run", "browser_observe", "browser_session", "browser_finalize"];
const startupCodes = ["MCP_ACCESS_DENIED", "MCP_RUNTIME_SETUP_REQUIRED"];
export function pluginLaunch(version) {
  if (!/^(?:latest|\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?)$/.test(version ?? "")) throw new Error("Use --version latest or an exact package version");
  const args = ["-y", "--package", `opencode-chromium@${version}`, "opencode-chromium-mcp", "--managed"];
  return process.platform === "win32" ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `npx ${args.join(" ")}`] } : { command: "npx", args };
}

export function installedLaunch(version, { pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."), runtimeDir = process.env.OPENCODE_BROWSER_RUNTIME_DIR ? path.resolve(process.env.OPENCODE_BROWSER_RUNTIME_DIR) : process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"), "OpenCode/browser") : path.join(os.homedir(), ".config/opencode/browser") } = {}) {
  // Validate before using the legacy npm fallback's shell command.
  const fallback = pluginLaunch(version);
  const file = path.join(pluginRoot, ".mcp.json");
  if (fs.existsSync(file)) {
    const config = JSON.parse(fs.readFileSync(file, "utf8")).mcpServers?.["opencode-browser-plugin"];
    if (typeof config?.command !== "string" || !Array.isArray(config.args) || config.args.some(arg => typeof arg !== "string")) throw new Error("Invalid installed MCP launcher");
    // .cmd launchers need cmd.exe on Windows. Values here come from the trusted
    // installed plugin, never a page or a model-generated command.
    if (process.platform === "win32" && config.command === "npx") {
      if (config.args.some(arg => !/^[\w@./=-]+$/.test(arg))) throw new Error("Unsupported installed npm launcher arguments");
      return { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npx " + config.args.join(" ")], source: "installed_plugin", timeoutMs: 180000 };
    }
    return { command: config.command, args: config.args, source: "installed_plugin", timeoutMs: 30000 };
  }
  if (fs.existsSync(path.join(runtimeDir, "runtime.json")) && fs.existsSync(path.join(runtimeDir, "mcp.mjs"))) {
    const active = JSON.parse(fs.readFileSync(path.join(runtimeDir, "runtime.json"), "utf8"));
    if (version === "latest" || active.version === version) return { command: process.execPath, args: [path.join(runtimeDir, "mcp.mjs")], source: "managed_runtime", timeoutMs: 30000 };
  }
  return { ...fallback, source: "npm_package", timeoutMs: 180000 };
}

function startupError(stderr) {
  if (/(?:EPERM|EACCES|Access (?:is )?denied)/i.test(stderr)) return "MCP_ACCESS_DENIED";
  for (const line of stderr.split(/\r?\n/).reverse()) {
    try { const data = JSON.parse(line); if (startupCodes.includes(data.code)) return data.code; } catch { /* Other startup logs are not protocol output. */ }
  }
  return /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/.test(stderr) ? "MCP_DEPENDENCY_MISSING" : "MCP_EXITED";
}

export function probeMcp({ command, args, timeoutMs = 30000, env = process.env }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env });
    let buffer = "", stderr = "", settled = false, serverVersion;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.stdin.end();
      const grace = setTimeout(() => {
        if (child.exitCode !== null || !child.pid) return;
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => {});
        } else child.kill();
      }, 1000);
      grace.unref(); resolve({ ...result, ...(serverVersion ? { serverVersion } : {}), stderr });
    };
    const timer = setTimeout(() => finish({ ok: false, code: "MCP_STARTUP_TIMEOUT" }), timeoutMs);
    const send = value => { if (!settled) child.stdin.write(JSON.stringify(value) + "\n"); };
    child.stdin.on("error", () => {});
    child.on("error", () => finish({ ok: false, code: "MCP_LAUNCH_FAILED" }));
    child.on("exit", code => finish({ ok: false, code: startupError(stderr), exitCode: code }));
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) return finish({ ok: false, code: "MCP_INVALID_RESPONSE" });
      for (;;) {
        const end = buffer.indexOf("\n"); if (end === -1) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { return finish({ ok: false, code: "MCP_INVALID_RESPONSE" }); }
        if (message.error) return finish({ ok: false, code: "MCP_HANDSHAKE_FAILED" });
        if (message.id === 1) {
          const version = message.result?.serverInfo?.version;
          if (typeof version === "string" && version.length <= 64 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) serverVersion = version;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        }
        if (message.id === 2) {
          const tools = Array.isArray(message.result?.tools) ? message.result.tools.map(tool => tool.name) : [];
          const missing = requiredTools.filter(name => !tools.includes(name));
          return finish({ ok: missing.length === 0, code: missing.length ? "MCP_TOOLS_MISSING" : "MCP_READY", tools, missing });
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "browser-startup-diagnostic", version: "1" } } });
  });
}

/** Preserve one proven broken entry in npm's actual cache; never clear the cache. */
export function quarantineBrokenCache(stderr, cacheRoot) {
  const match = /['"]([^'"\r\n]+[\\/]_npx[\\/]([a-f0-9]+))[\\/]node_modules[\\/]/i.exec(stderr);
  if (!match) throw new Error("The error does not identify an npm execution cache entry");
  const root = fs.realpathSync(path.join(cacheRoot, "_npx")), entry = path.resolve(match[1]);
  // Resolve the parent before comparing: macOS commonly exposes the same
  // temporary directory through /var and /private/var. The entry itself must
  // still be a real directory directly inside the configured cache.
  if (fs.lstatSync(entry).isSymbolicLink() || fs.realpathSync(path.dirname(entry)) !== root || path.dirname(fs.realpathSync(entry)) !== root) throw new Error("Cache entry is outside the expected npm cache");
  const pkg = JSON.parse(fs.readFileSync(path.join(entry, "node_modules", "opencode-chromium", "package.json"), "utf8"));
  if (pkg.name !== "opencode-chromium") throw new Error("Cache entry does not contain this browser runtime");
  const backup = `${entry}.broken-${Date.now()}`; fs.renameSync(entry, backup); return backup;
}

function cacheDirectory() {
  const output = process.platform === "win32" ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "npm config get cache"], { encoding: "utf8", windowsHide: true }) : execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8" });
  return output.trim();
}

export const codexReloadSteps = [
  "Open Plugins → OpenCode Browser Plugin → Manage.",
  "Disable the plugin, then enable it again. Keep Codex and the other agents running; do not uninstall or restart the app.",
  "Return to the same chat, invoke the skill again, then retry browser_session once with the intended profile.",
];

export function diagnosticReport(result, { version, repaired = false, toolsUnavailable = false }) {
  const { stderr: _stderr, ...startup } = result;
  const reload = result.ok && toolsUnavailable;
  return { ...startup, ...(reload ? { ok: false, code: "MCP_CHAT_RELOAD_REQUIRED", startupCode: result.code } : {}), version: result.serverVersion ?? version, requestedVersion: version, repaired,
    ...(result.ok ? { reloadSteps: codexReloadSteps } : {}),
    next: result.ok ?
      "The fresh process advertises the browser tools. If this chat lacks them, reload the plugin: Plugins → OpenCode Browser Plugin → Manage → disable → enable. Invoke the skill again in the same chat and verify its tools, then one harmless browser action. Reloading only the skill does not reconnect MCP. Keep Codex and other agents running. This probe does not establish chat registration or browser connectivity." :
      result.code === "MCP_ACCESS_DENIED" ? "The harness sandbox cannot access the installed runtime. Ask the user to Approve or Disapprove a permitted local CLI diagnostic outside that sandbox; do not change ACLs, reinstall, or restart Codex." :
      result.code === "MCP_RUNTIME_SETUP_REQUIRED" ? "Install or repair the local runtime with opencode-chromium setup --all, then reload this plugin in Manage (disable, then enable). Keep Codex and other agents running." :
      result.code === "MCP_DEPENDENCY_MISSING" ? "Run this script once with --repair-cache to preserve the damaged npm execution cache and reinstall it." :
      result.code === "MCP_STARTUP_TIMEOUT" ? "Installation or startup exceeded the probe budget. Inspect network and local startup logs before retrying once, then reload the plugin after a successful probe." :
      "Inspect the client's local MCP startup error. Do not repeatedly reinstall the extension or clear all npm caches." };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) { console.log("node diagnose-mcp.mjs [--version VERSION|latest] [--plugin-root PATH] [--tools-unavailable] [--repair-cache]\nChecks the installed plugin command or managed runtime with initialize + tools/list, without opening tabs. --tools-unavailable reports a healthy startup with missing chat tools as MCP_CHAT_RELOAD_REQUIRED. Repair preserves one broken npm execution cache and retries once."); return; }
  const index = argv.indexOf("--version"), version = index === -1 ? "latest" : argv[index + 1];
  const rootIndex = argv.indexOf("--plugin-root");
  const launch = installedLaunch(version, rootIndex === -1 ? undefined : { pluginRoot: argv[rootIndex + 1] });
  let result = await probeMcp(launch), repaired = false;
  if (!result.ok && result.code === "MCP_DEPENDENCY_MISSING" && argv.includes("--repair-cache")) {
    quarantineBrokenCache(result.stderr, cacheDirectory()); repaired = true; result = await probeMcp(launch);
  }
  const report = diagnosticReport(result, { version, repaired, toolsUnavailable: argv.includes("--tools-unavailable") });
  console.log(JSON.stringify({ ...report, launchSource: launch.source }, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ ok: false, code: "MCP_DIAGNOSTIC_FAILED", message: error.message })); process.exitCode = 1; });
