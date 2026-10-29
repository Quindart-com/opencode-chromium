#!/usr/bin/env node
// Built-ins only: usable from the skill even when MCP dependencies are broken.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const requiredTools = ["browser_run", "browser_observe", "browser_session", "browser_finalize"];
export function pluginLaunch(version) {
  if (!/^(?:latest|\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?)$/.test(version ?? "")) throw new Error("Use --version latest or an exact package version");
  const args = ["-y", "--package", `opencode-chromium@${version}`, "opencode-chromium-mcp", "--managed"];
  return process.platform === "win32" ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `npx ${args.join(" ")}`] } : { command: "npx", args };
}

export function probeMcp({ command, args, timeoutMs = 180000 }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", stderr = "", settled = false;
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
      grace.unref(); resolve({ ...result, stderr });
    };
    const timer = setTimeout(() => finish({ ok: false, code: "MCP_STARTUP_TIMEOUT" }), timeoutMs);
    const send = value => { if (!settled) child.stdin.write(JSON.stringify(value) + "\n"); };
    child.stdin.on("error", () => {});
    child.on("error", () => finish({ ok: false, code: "MCP_LAUNCH_FAILED" }));
    child.on("exit", code => finish({ ok: false, code: /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/.test(stderr) ? "MCP_DEPENDENCY_MISSING" : "MCP_EXITED", exitCode: code }));
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

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) { console.log("node diagnose-mcp.mjs [--version VERSION|latest] [--repair-cache]\nChecks initialize + tools/list without opening tabs. Repair preserves one broken npm execution cache and retries once."); return; }
  const index = argv.indexOf("--version"), version = index === -1 ? "latest" : argv[index + 1];
  const launch = pluginLaunch(version);
  let result = await probeMcp(launch), repaired = false;
  if (!result.ok && result.code === "MCP_DEPENDENCY_MISSING" && argv.includes("--repair-cache")) {
    quarantineBrokenCache(result.stderr, cacheDirectory()); repaired = true; result = await probeMcp(launch);
  }
  const { stderr: _stderr, ...publicResult } = result;
  console.log(JSON.stringify({ ...publicResult, version, repaired, next: result.ok ?
    "The fresh process advertises the browser tools. If this chat still lacks them, reconnect MCP or reopen Codex and start a new chat. This does not establish browser connectivity." :
    result.code === "MCP_DEPENDENCY_MISSING" ? "Run this script once with --repair-cache to preserve the damaged npm execution cache and reinstall it." :
    result.code === "MCP_STARTUP_TIMEOUT" ? "Installation or startup exceeded three minutes. Inspect network and local startup logs before retrying once, then reconnect MCP after a successful probe." :
    "Inspect the client's local MCP startup error. Do not repeatedly reinstall the extension or clear all npm caches." }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ ok: false, code: "MCP_DIAGNOSTIC_FAILED", message: error.message })); process.exitCode = 1; });
