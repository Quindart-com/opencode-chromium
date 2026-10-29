import fs from "node:fs";
import path from "node:path";
import { parseRuntimeActivation,runtimeLifecycleSource,withRuntimeLock } from "../../native-host/src/runtime-lifecycle.ts";
import { packagedRuntime } from "../../native-host/src/runtime-updates.ts";
import { CODEX_MARKETPLACE_UPDATE } from "../cli/codex-marketplace.ts";
import { runActivationCoordinator } from "../../native-host/src/runtime-coordinator.ts";
import { packageRoot } from "../cli/config.ts";
import { applyRegistryChanges,planNativeHosts,runtimeDir } from "../cli/native-host.ts";
import { launcherSource } from "../cli/runtime-link.ts";
import { record } from "../shared/values.ts";
import { managedConfiguration,nativeCodexPluginEnabled,type HarnessId } from "./configuration.js";
import { detectHarnesses,planHarness,type Harness } from "./harnesses.js";
import { selectHarnesses } from "./menu.js";
import { offerRestart } from "./restart.js";
import { opencodeV2Launcher } from "./opencode-v2.ts";
import { planSkills } from "./skills.js";
import { applyTransaction,type FileChange } from "./transaction.js";
import { ensureManagedRelease,supervisorFiles } from "./supervisor.ts";
import { refreshBrowserMarketplace } from "./marketplace.ts";

interface SetupEnvironment {
  home?: string;
  dir?: string;
  root?: string;
  rows?: Harness[];
  planHosts?: typeof planNativeHosts;
  registerHosts?: typeof applyRegistryChanges;
  restart?: typeof offerRestart;
}

export async function manageSetup(argv: string[], remove = false, environment: SetupEnvironment = {}) {
  if (argv.includes("--auto-update") && argv.includes("--no-auto-update")) throw new Error("Choose --auto-update or --no-auto-update");
  const dir = environment.dir ?? runtimeDir();
  const rows = (environment.rows ?? detectHarnesses()).map(row => ({ ...row }));
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--config") continue;
    const override = argv[++index];
    const delimiter = override?.indexOf("=") ?? -1;
    const row = rows.find(row => row.id === override?.slice(0, delimiter));
    if (!row || delimiter < 1 || !override?.slice(delimiter + 1)) throw new Error("Use --config harness-id=/absolute/config/path");
    row.configPath = path.resolve(override.slice(delimiter + 1));
    if (fs.existsSync(row.configPath)) {
      row.detected = true;
      const current = fs.readFileSync(row.configPath, "utf8");
      row.managed = managedConfiguration(current, row.id, path.join(dir, "plugin.mjs"));
    } else row.managed = false;
  }
  if (argv.includes("--all") && argv.includes("--targets")) throw new Error("Choose --all or --targets, not both");
  const targetValue = argv[argv.indexOf("--targets") + 1];
  if (argv.includes("--targets") && (!targetValue || targetValue.startsWith("--") || !targetValue.split(",").every(id => id.trim()))) {
    throw new Error("Use --targets codex,opencode,claude-code,claude-desktop,dsh, or --all for detected apps");
  }
  const explicit = argv.includes("--all") ? rows.filter(row => row.detected && row.supported).map(row => row.id) :
    argv.includes("--targets") ? [...new Set(targetValue!.split(",").map(id => id.trim()))] : undefined;
  if (argv.includes("--json") && !explicit) return { ok: true, applied: false, harnesses: rows, runtimeDir: dir };
  const selected = explicit ?? await selectHarnesses(rows);
  if (!selected.length && !argv.includes("--all")) return { ok: true, applied: false, harnesses: rows };
  for (const id of selected) if (!rows.some(row => row.id === id)) throw new Error(`Unknown harness: ${id}`);
  const root = environment.root ?? packageRoot();
  const pkg = record(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as unknown);
  if (!remove && !fs.existsSync(path.join(root, "dist", "build-manifest.json"))) throw new Error("Build the runtime before setup: bun run build");
  const changes: FileChange[] = [];
  for (const row of rows) {
    if (selected.includes(row.id)) changes.push(planHarness(row, dir, remove ? "uninstall" : "install"));
    else if (!explicit && row.managed) changes.push(planHarness(row, dir, "uninstall"));
  }
  const nativePlugins = remove ? [] : rows.filter(row => selected.includes(row.id) && row.id === "codex" &&
    fs.existsSync(row.configPath) && nativeCodexPluginEnabled(fs.readFileSync(row.configPath, "utf8"))).map(row => row.id);
  changes.push(...planSkills(root, selected.filter(id => !nativePlugins.includes(id as HarnessId)) as HarnessId[], remove, environment.home));
  const dryRun = argv.includes("--dry-run");
  let pendingRelease: { root: string; version: string } | null = null;
  if (!remove) {
    changes.push(...supervisorFiles(dir));
    const lifecycle = path.join(dir, "runtime-lifecycle.mjs");
    changes.push({ filePath: lifecycle, before: fs.existsSync(lifecycle) ? fs.readFileSync(lifecycle, "utf8") : null, after: runtimeLifecycleSource() });
    for (const kind of ["host", "mcp", "plugin"] as const) {
      const filePath = path.join(dir, `${kind}.mjs`);
      changes.push({ filePath, before: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null, after: launcherSource(kind) });
    }
    if (selected.includes("opencode")) {
      const filePath = path.join(dir, "v2", "index.ts");
      changes.push({ filePath, before: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null, after: opencodeV2Launcher });
    }
    const filePath = path.join(dir, "runtime.json");
    const existing = fs.existsSync(filePath) ? parseRuntimeActivation(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown) : null;
    const production = argv.includes("--production");
    const managed = packagedRuntime(root) && pkg.name === "opencode-chromium" && typeof pkg.version === "string" && !(existing?.followBranch && !production);
    const selectedRoot = managed ? dryRun ? path.join(dir, "releases", String(pkg.version), "node_modules/opencode-chromium") : await ensureManagedRelease(dir, String(pkg.version)) : root;
    const manifest = existing?.followBranch && !production ? existing : { ...existing, root: selectedRoot, version: pkg.version,
      generation: existing?.generation ?? 0,
      autoUpdate: argv.includes("--no-auto-update") ? false : argv.includes("--auto-update") ? true : existing?.autoUpdate ?? packagedRuntime(root),
      ...(production ? { channel: "production", followBranch: false, pendingReload: true } : {}) };
    // After the one-time legacy migration, setup uses the same global switch
    // transaction as automatic updates instead of replacing a live pointer.
    if (managed && existing && existing.root !== selectedRoot && existing.autoUpdate !== false && fs.existsSync(path.join(dir, "supervisor/1/runtime-supervisor.js"))) {
      pendingRelease = { root: selectedRoot, version: String(pkg.version) };
      Object.assign(manifest, { root: existing.root, version: existing.version, stagedRelease: pendingRelease });
    }
    changes.push({ filePath, before: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null, after: JSON.stringify(manifest, null, 2) + "\n" });
  }
  const hosts = !remove ? (environment.planHosts ?? planNativeHosts)(dir) : null;
  if (hosts) changes.push(...hosts.changes);
  const apply = () => applyTransaction(changes, dryRun, hosts ? () => { if (process.platform !== "win32") fs.chmodSync(hosts.hostPath, 0o755); (environment.registerHosts ?? applyRegistryChanges)(hosts.registry); } : undefined);
  const result = dryRun ? apply() : await withRuntimeLock(dir, apply);
  if (!dryRun && pendingRelease) await runActivationCoordinator(dir, pendingRelease, async () => false);
  const restarts = dryRun ? [] : await (environment.restart ?? offerRestart)(selected, argv.includes("--restart"), !argv.includes("--json"));
  const marketplace = !dryRun && !remove && nativePlugins.includes("codex") && pkg.name === "opencode-chromium" && packagedRuntime(root) ?
    await refreshBrowserMarketplace({ version: String(pkg.version), dir, ...(environment.home ? { home: path.join(environment.home, ".codex") } : {}) }) : null;
  return { ok: true, applied: !dryRun, dryRun, action: remove ? "uninstall" : "install", ...result, targets: selected,
    restarts, nativePlugins, marketplace,
    pluginUpdates: nativePlugins.includes("codex") ? [{ id: "codex", command: CODEX_MARKETPLACE_UPDATE,
      instruction: "Codex manages the plugin catalog separately from the browser runtime. Refresh the marketplace, then reopen Codex and select the updated plugin." }] : [],
    pendingReload: dryRun ? [] : rows.filter(row => selected.includes(row.id)).map(row => ({ id: row.id,
      instruction: row.restart === "desktop" ? "Quit and reopen the desktop application to reload MCP configuration." : "Reconnect MCP or relaunch the terminal session to reload tools." })),
    browserSetup: hosts ? `${dryRun ? "Will register" : "Registered"} native hosts for installed browsers. Install the browser extension; Firefox and LibreWolf also need remote debugging configured (see docs/firefox.md).` :
      "Browser extension and native host registration were left in place." };
}

export function formatSetupResult(result: Awaited<ReturnType<typeof manageSetup>>): string {
  if (!result.applied && !("dryRun" in result)) return "No changes made. Run setup --all to connect detected apps, or setup --targets codex to choose one app.";
  const targets = "targets" in result ? result.targets : [];
  const changed = "changedFiles" in result ? result.changedFiles : [];
  const preview = "dryRun" in result && result.dryRun;
  const completed = "action" in result && result.action === "uninstall" ? "Disconnected" : "Setup complete";
  const heading = preview ? "Preview" : changed.length ? completed : "Already up to date";
  const lines = [`${heading}: ${targets.join(", ") || "browser connection only"}.`,
    `${changed.length} file${changed.length === 1 ? "" : "s"} ${preview ? "would change" : "changed"}.`];
  if ("nativePlugins" in result && result.nativePlugins.length) lines.push("Codex uses its enabled native browser plugin; no duplicate MCP server or skill was added.");
  if ("pluginUpdates" in result) for (const entry of result.pluginUpdates) lines.push(`${entry.id}: ${entry.instruction} Run: ${entry.command}`);
  if ("pendingReload" in result) for (const entry of result.pendingReload) lines.push(`${entry.id}: ${entry.instruction}`);
  if ("browserSetup" in result) lines.push(result.browserSetup);
  return lines.join("\n");
}
