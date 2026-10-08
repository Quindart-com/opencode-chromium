#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { main as mcpMain } from "../adapters/mcp/server.js";
import { manageSetup } from "../management/setup.ts";
import { runProviderCommand } from "./providers.ts";
import { runFirefoxCommand } from "./firefox.js";
import { activateChannel, readActivation } from "../management/channels.ts";
import { runtimeDir } from "./native-host.js";
import { packageRoot } from "./config.js";
import { writeLaunchers } from "./runtime-link.js";
import { BrowserHostClient } from "../browser/client.js";
import { readProfileRegistrations } from "../../native-host/src/profile-registry.js";

async function runtimeBusy() {
  const profiles = [...readProfileRegistrations(), ...["development", "production"].flatMap(channel =>
    readProfileRegistrations(path.join(runtimeDir(), "state", channel, "profiles")))];
  for (const profile of profiles) {
    if (!profile.ipcPath) continue;
    const client = new BrowserHostClient({ ipcPath: profile.ipcPath, timeoutMs: 1000 });
    try {
      const activity = await client.request("runtime.activity", {});
      if (activity.clients > 0 || activity.pending > 0) return true;
    } catch {
      try { process.kill(profile.hostPid, 0); return true; } catch { /* stale registration */ }
    } finally { client.close(); }
  }
  return false;
}
import { configureClient } from "./configure.js";
import { runDoctor } from "./doctor.js";
import { installClient } from "./install.js";
import { runMemoryCommand } from "./memory.js";
import { linkClientSurfaces, linkRuntime, runtimeStatus, syncRuntime } from "./runtime-link.js";
import { uninstallClient } from "./uninstall.js";
import { verify } from "./verify.js";
import { packageInfo } from "./version.js";

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function has(argv, flag) {
  return argv.includes(flag);
}

// One place that answers "which version is actually running", instead of
// asking the user to remember which installer ran last.
export function formatRuntimeStatus(status) {
  const lines = [];
  const mark = (ok) => ok ? "ok" : "DRIFT";
  lines.push(`runtime dir    ${status.runtimeDir}`);
  lines.push(`linked         ${status.linked ? `ok  ${status.manifest?.root}` : "DRIFT  not linked to this checkout"}`);
  lines.push(`checkout       ${status.branch ?? "?"} @ ${status.revision ?? "?"}${status.dirty ? " (uncommitted changes)" : ""} v${status.version ?? "?"}`);
  lines.push(`bundle         ${status.build.stale ? "DRIFT  stale, run: bun run sync" : `ok  built ${status.build.builtAt ?? "unknown"}`}`);
  const registered = status.registration.filter((entry) => entry.registered);
  const stale = registered.filter((entry) => !entry.installed).map((entry) => entry.browser);
  lines.push(`browser        ${registered.length > 0 ? `ok  ${registered.map((entry) => entry.browser).join(", ")}${stale.length > 0 ? ` (${stale.join(", ")} not installed)` : ""}` : "DRIFT  no browser has the native host registered"}`);
  lines.push(`running hosts  ${status.hosts === null ? "unknown (cannot enumerate processes)" : status.hosts.length === 0 ? "none right now (the extension starts one on demand)" : `${status.hosts.length} pid ${status.hosts.map((host) => host.pid).join(", ")}`}`);
  for (const skill of status.skills) lines.push(`skill          ${mark(skill.parity)}  ${skill.path}`);
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const [command = "doctor", ...rest] = argv;
  const activation = ["link", "sync"].includes(command) ? readActivation(runtimeDir()) : null;
  if (command === "link" && has(rest, "--follow-branch") || command === "sync" && activation?.followBranch) {
    const root = packageRoot();
    if (command === "sync" && has(rest, "--if-linked") && activation.sourceRoot !== root) return;
    const result = await activateChannel({ root, dir: runtimeDir(), dryRun: has(rest, "--dry-run"), isBusy: runtimeBusy });
    if (result.activated) writeLaunchers(root, runtimeDir());
    if (!has(rest, "--quiet")) console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "providers") {
    console.log(JSON.stringify(runProviderCommand(rest), null, 2));
    return;
  }
  if (command === "firefox") { console.log(JSON.stringify(await runFirefoxCommand(rest), null, 2)); return; }
  if (["setup", "manage", "update"].includes(command) || command === "uninstall" && !has(rest, "--client")) {
    console.log(JSON.stringify(await manageSetup(rest, command === "uninstall"), null, 2));
    return;
  }
  if (command === "mcp") return mcpMain(rest);
  if (command === "memory" || command === "history") return runMemoryCommand(rest);
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(JSON.stringify(packageInfo(), null, 2));
    return;
  }
  if (command === "doctor") {
    const result = await runDoctor({ json: has(rest, "--json") });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "verify") {
    console.log(JSON.stringify(await verify(), null, 2));
    return;
  }
  if (command === "link") {
    const dryRun = has(rest, "--dry-run");
    const result = linkRuntime({ dryRun });
    const clients = dryRun ? { results: [] } : linkClientSurfaces({ dir: result.dir });
    // Config bodies are large; report what changed, not the file contents.
    const changedClients = clients.results.map(({ before: _before, after: _after, ...entry }) => entry);
    console.log(JSON.stringify({ ok: true, ...result, clients: changedClients }, null, 2));
    return;
  }
  if (command === "status") {
    const status = runtimeStatus();
    if (has(rest, "--json")) console.log(JSON.stringify(status, null, 2));
    else console.log(formatRuntimeStatus(status));
    return;
  }
  if (command === "sync") {
    const quiet = has(rest, "--quiet");
    const result = syncRuntime({ quiet, ifLinked: has(rest, "--if-linked") });
    if (!quiet) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  if (["install", "configure", "uninstall"].includes(command)) {
    const client = valueAfter(rest, "--client");
    if (!client) throw new Error(`${command} requires --client opencode|opencode-mcp|codex|skills`);
    const options = { client, config: valueAfter(rest, "--config"), dryRun: has(rest, "--dry-run"), serverPath: valueAfter(rest, "--server") };
    const result = command === "install" ? installClient(options) : command === "configure" ? configureClient(options) : uninstallClient(options);
    const { before: _before, after: _after, ...publicResult } = result;
    const changedFiles = Array.isArray(result.changedFiles) ? result.changedFiles : result.changed ? [result.filePath] : [];
    console.log(JSON.stringify({ ok: true, ...publicResult, changedFiles }, null, 2));
    return;
  }
  if (command === "help" || command === "--help") {
    console.log("Usage: opencode-chromium <setup|manage|update|link|status|sync|install|configure|uninstall|doctor|verify|mcp|version>");
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1]?.endsWith("src\\cli\\index.js") || process.argv[1]?.endsWith("src/cli/index.js") || process.argv[1]?.endsWith("dist\\cli\\index.js") || process.argv[1]?.endsWith("dist/cli/index.js")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
