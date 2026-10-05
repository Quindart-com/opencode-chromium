import fs from "node:fs";
import path from "node:path";
import { detectHarnesses, planHarness } from "./harnesses.js";
import { selectHarnesses } from "./menu.js";
import { applyTransaction, type FileChange } from "./transaction.js";
import { runtimeDir } from "../cli/native-host.js";
import { packageRoot } from "../cli/config.js";
import { launcherSource } from "../cli/runtime-link.js";
import { offerRestart } from "./restart.js";
import { planSkills } from "./skills.js";
import type { HarnessId } from "./configuration.js";

export async function manageSetup(argv: string[], remove = false) {
  const flag = (name: string) => argv[argv.indexOf(name) + 1];
  const dir = runtimeDir();
  const rows = detectHarnesses();
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--config") continue;
    const override = argv[++index];
    const delimiter = override?.indexOf("=") ?? -1;
    const row = rows.find(row => row.id === override?.slice(0, delimiter));
    if (!row || delimiter < 1 || !override?.slice(delimiter + 1)) throw new Error("Use --config harness-id=/absolute/config/path");
    row.configPath = path.resolve(override.slice(delimiter + 1));
  }
  const explicit = argv.includes("--targets") ? flag("--targets")?.split(",") : undefined;
  if (argv.includes("--json") && !explicit) return { ok: true, applied: false, harnesses: rows, runtimeDir: dir };
  const selected = explicit ?? await selectHarnesses(rows);
  if (!selected.length) return { ok: true, applied: false, harnesses: rows };
  for (const id of selected) if (!rows.some(row => row.id === id)) throw new Error(`Unknown harness: ${id}`);
  const root = packageRoot();
  if (!remove && !fs.existsSync(path.join(root, "dist", "build-manifest.json"))) throw new Error("Build the runtime before setup: bun run build");
  const changes: FileChange[] = [];
  for (const row of rows) {
    if (selected.includes(row.id)) changes.push(planHarness(row, dir, remove ? "uninstall" : "install"));
    else if (!explicit && row.managed) changes.push(planHarness(row, dir, "uninstall"));
  }
  changes.push(...planSkills(root, selected as HarnessId[], remove));
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
  const result = applyTransaction(changes, dryRun);
  const restarts = dryRun ? [] : await offerRestart(selected, argv.includes("--restart"), !argv.includes("--json"));
  return { ok: true, applied: !dryRun, dryRun, ...result, targets: selected,
    restarts,
    pendingReload: dryRun ? [] : rows.filter(row => selected.includes(row.id)).map(row => ({ id: row.id,
      instruction: row.restart === "desktop" ? "Quit and reopen the desktop application to reload MCP configuration." : "Reconnect MCP or relaunch the terminal session to reload tools." })),
    browserSetup: "Install the browser extension, then run opencode-chromium link to register its native messaging host." };
}
