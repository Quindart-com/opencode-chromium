import fs from "node:fs";
import path from "node:path";
import { detectHarnesses, planHarness, type Harness } from "./harnesses.js";
import { selectHarnesses } from "./menu.js";
import { applyTransaction, type FileChange } from "./transaction.js";
import { runtimeDir, planNativeHosts, applyRegistryChanges } from "../cli/native-host.js";
import { packageRoot } from "../cli/config.js";
import { launcherSource } from "../cli/runtime-link.js";
import { offerRestart } from "./restart.js";
import { planSkills } from "./skills.js";
import { nativeCodexPluginEnabled, managedConfiguration, type HarnessId } from "./configuration.js";

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
  if (!remove) {
    for (const kind of ["host", "mcp", "plugin"] as const) {
      const filePath = path.join(dir, `${kind}.mjs`);
      changes.push({ filePath, before: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null, after: launcherSource(kind) });
    }
    const filePath = path.join(dir, "runtime.json");
    const existing = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) as { followBranch?: boolean; stateIsolation?: boolean } : null;
    const production = argv.includes("--production");
    const manifest = existing?.followBranch && !production ? existing : { ...existing, root, version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
      ...(production ? { channel: "production", followBranch: false, pendingReload: true } : {}) };
    changes.push({ filePath, before: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null, after: JSON.stringify(manifest, null, 2) + "\n" });
  }
  const hosts = !remove ? (environment.planHosts ?? planNativeHosts)(dir) : null;
  if (hosts) changes.push(...hosts.changes);
  const result = applyTransaction(changes, dryRun, hosts ? () => { if (process.platform !== "win32") fs.chmodSync(hosts.hostPath, 0o755); (environment.registerHosts ?? applyRegistryChanges)(hosts.registry); } : undefined);
  const restarts = dryRun ? [] : await (environment.restart ?? offerRestart)(selected, argv.includes("--restart"), !argv.includes("--json"));
  return { ok: true, applied: !dryRun, dryRun, action: remove ? "uninstall" : "install", ...result, targets: selected,
    restarts, nativePlugins,
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
  if ("pendingReload" in result) for (const entry of result.pendingReload) lines.push(`${entry.id}: ${entry.instruction}`);
  if ("browserSetup" in result) lines.push(result.browserSetup);
  return lines.join("\n");
}
