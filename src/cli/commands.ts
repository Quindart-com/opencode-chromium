import { record } from "../shared/values.ts";
import type { ClientInstallOptions } from "./install.ts";
import { formatRuntimeStatus } from "./status-format.ts";

import path from "node:path";
import process from "node:process";
import { BrowserHostClient } from "../browser/client.ts";
import { activateChannel,readActivation } from "../management/channels.ts";
import { developmentExtensionSource,publishDevelopmentExtension } from "../management/development-extension.ts";
import { formatSetupResult,manageSetup } from "../management/setup.ts";
import { readProfileRegistrations } from "../shared/profile-registry.ts";
import { packageRoot } from "./config.ts";
import { installClient,SUPPORTED_CLIENTS,uninstallClient } from "./install.ts";
import { runtimeDir } from "./native-host.ts";
import { linkClientSurfaces,linkRuntime,runtimeStatus,syncRuntime,writeLaunchers } from "./runtime-link.ts";


async function runtimeBusy() {
  const profiles = [...readProfileRegistrations(), ...["development", "production"].flatMap(channel =>
    readProfileRegistrations(path.join(runtimeDir(), "state", channel, "profiles")))];
  for (const profile of profiles) {
    if (!profile.ipcPath) continue;
    const client = new BrowserHostClient({ ipcPath: profile.ipcPath, timeoutMs: 1000 });
    try {
      const activity = record(await client.request("runtime.activity", {}));
      if (Number(activity.clients) > 0 || Number(activity.pending) > 0) return true;
    } catch {
      try { process.kill(profile.hostPid ?? process.pid, 0); return true; } catch { /* stale registration */ }
    } finally { client.close(); }
  }
  return false;
}

function valueAfter(argv: string[], flag: string) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function has(argv: string[], flag: string) {
  return argv.includes(flag);
}

export async function dispatchCommand(argv = process.argv.slice(2)) {
  const [command = "doctor", ...rest] = argv;
  if (command === "harness" && rest[0] === "reconnect") {
    const { reconnectHarness } = await import("../management/harness-reconnect.ts");
    console.log(JSON.stringify(await reconnectHarness(rest[1], runtimeDir()), null, 2)); return;
  }
  if (command === "updates" && rest[0] === "install") {
    const { installPublishedUpdate } = await import("../management/manual-update.ts");
    console.log(JSON.stringify(await installPublishedUpdate(runtimeDir()), null, 2)); return;
  }
  if (command === "dev-extension") {
    if (has(rest, "--help")) { console.log("Build and refresh the stable unpacked extension without changing the production runtime:\n  opencode-chromium dev-extension --source <checkout> [--output <existing-extension-directory>] [--dry-run]\nReload the unpacked extension at the returned extensionPath after the build."); return; }
    console.log(JSON.stringify(await publishDevelopmentExtension({ root: valueAfter(rest, "--source") ?? process.cwd(), dir: runtimeDir(), output: valueAfter(rest, "--output"), dryRun: has(rest, "--dry-run") }), null, 2));
    return;
  }
  if (command === "sync" && !readActivation(runtimeDir())?.followBranch) {
    const source = developmentExtensionSource(runtimeDir());
    if (source && path.resolve(source) === path.resolve(packageRoot())) {
      const result = await publishDevelopmentExtension({ root: source, dir: runtimeDir(), dryRun: has(rest, "--dry-run") });
      if (!has(rest, "--quiet")) console.log(JSON.stringify(result, null, 2));
      return;
    }
  }
  if (command === "updates") {
    const { createRuntimeUpdater } = await import("../control/update.ts");
    const updater = createRuntimeUpdater({ dir: runtimeDir() });
    if (![undefined, "status", "on", "off"].includes(rest[0])) throw new Error("Use updates status, updates on, or updates off");
    console.log(JSON.stringify(rest[0] !== undefined && ["on", "off"].includes(rest[0]) ? await updater.configure(rest[0] === "on") : updater.status(), null, 2));
    return;
  }
  const activation = ["link", "sync"].includes(command) ? readActivation(runtimeDir()) : null;
  if (command === "link" && has(rest, "--follow-branch") || command === "sync" && activation?.followBranch) {
    const root = packageRoot();
    if (command === "sync" && has(rest, "--if-linked") && activation?.sourceRoot !== root) return;
    const result = await activateChannel({ root, dir: runtimeDir(), dryRun: has(rest, "--dry-run"), isBusy: runtimeBusy });
    if (result.activated) writeLaunchers(root, runtimeDir());
    if (!has(rest, "--quiet")) console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "providers") {
    const { runProviderCommand } = await import("./providers.ts");
    console.log(JSON.stringify(runProviderCommand(rest), null, 2));
    return;
  }
  if (command === "firefox") { const { runFirefoxCommand } = await import("./firefox.ts"); console.log(JSON.stringify(await runFirefoxCommand(rest), null, 2)); return; }
  if (["setup", "manage", "update"].includes(command) || command === "uninstall" && !has(rest, "--client")) {
    if (has(rest, "--help") || has(rest, "-h")) {
      console.log("Connect your browser to agent apps:\n  opencode-chromium setup --all\n  opencode-chromium setup --targets codex,opencode\n  opencode-chromium setup --all --dry-run --json\n\nOptions:\n  --all           Connect all detected, supported apps\n  --targets       Choose apps: codex,opencode,claude-code,claude-desktop,dsh\n  --config        Override a file: harness-id=/absolute/path\n  --dry-run       Preview changes without writing files\n  --json          Print a machine-readable result\n  --production    Switch from a linked development runtime to this release\n  --restart       Gracefully restart selected desktop apps\n  --no-auto-update  Disable managed runtime updates\n  --auto-update     Enable managed runtime updates\n\nUpdate controls: opencode-chromium updates <status|on|off>");
      return;
    }
    const result = await manageSetup(rest, command === "uninstall");
    console.log(has(rest, "--json") ? JSON.stringify(result, null, 2) : formatSetupResult(result));
    return;
  }
  if (command === "mcp") return (await import("../adapters/mcp/server.ts")).main(rest);
  if (command === "memory" || command === "history") return (await import("./memory.ts")).runMemoryCommand(rest);

  if (command === "doctor") {
    if (has(rest, "--connection-only")) {
      const result = await (await import("./connection-doctor.ts")).connectionDoctor({ profileId: valueAfter(rest, "--profile"), repairRuntime: has(rest, "--repair-runtime") });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    const result = await (await import("./doctor.ts")).runDoctor({ json: has(rest, "--json"), repairRuntime: has(rest, "--repair-runtime") });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "verify") {
    console.log(JSON.stringify(await (await import("./verify.ts")).verify(), null, 2));
    return;
  }
  if (command === "link") {
    const dryRun = has(rest, "--dry-run");
    const result = linkRuntime({ dryRun });
    const clients = dryRun ? { results: [] } : linkClientSurfaces({ dir: result.dir });
    // Config bodies are large; report what changed, not the file contents.
    const changedClients = clients.results.map(value => { const { before: _before, after: _after, ...entry } = record(value); return entry; });
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
    if (!SUPPORTED_CLIENTS.includes(client)) throw new Error("Unsupported client");
    const options: ClientInstallOptions = { client: client as ClientInstallOptions["client"], config: valueAfter(rest, "--config"), dryRun: has(rest, "--dry-run"), serverPath: valueAfter(rest, "--server") };
    const result = command === "install" || command === "configure" ? installClient(options) : uninstallClient(options);
    const { before: _before, after: _after, ...publicResult } = record(result);
    const changedFiles = "changedFiles" in result ? result.changedFiles : result.changed ? [result.filePath] : [];
    console.log(JSON.stringify({ ok: true, ...publicResult, changedFiles }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}
