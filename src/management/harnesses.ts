import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimeDir } from "../cli/native-host.ts";
import { harnessDefinitions,harnessEnv,harnessTargets } from "../shared/harnesses.ts";
import { record } from "../shared/values.ts";
import { type HarnessId,managedConfiguration,planConfiguration } from "./configuration.ts";
import { existingFile,findExecutable,windowsAppPath } from "./executable-discovery.ts";
import { harnessConfigPath } from "./harness-paths.ts";
import type { FileChange } from "./transaction.js";

export interface Harness {
  id: HarnessId;
  label: string;
  detected: boolean;
  installed?: boolean;
  version: string | null;
  configPath: string;
  supported: boolean;
  restart: "desktop" | "terminal";
  executable: string | null;
  managed: boolean;
}
export function harnessVersion(binary: string | null): string | null {
  if (!binary) return null;
  if (/\.(cmd|ps1)$/.test(binary)) {
    const command = path.basename(binary).replace(/\.(cmd|ps1)$/, "");
    const packages = Object.values(harnessDefinitions).find(row => row.command === command)?.packages ?? [];
    for (const packageName of packages) {
      try { return record(JSON.parse(fs.readFileSync(path.join(path.dirname(binary), "node_modules", packageName, "package.json"), "utf8")) as unknown).version as string; } catch { /* Try the supported legacy package. */ }
    }
    return null;
  }
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  return result.status === 0 ? result.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null : null;
}
export function detectHarnesses(home = os.homedir(), { versions = true } = {}): Harness[] {
  return harnessTargets.map(id => {
    const definition = harnessDefinitions[id], supported = id !== "claude-desktop" || process.platform !== "linux";
    let filePath = harnessConfigPath(id, home);
    if (id === "opencode" && !process.env[harnessEnv(id, "CONFIG")] && fs.existsSync(filePath + "c")) filePath += "c";
    const override = process.env[harnessEnv(id, "EXECUTABLE")];
    const binary = override ? existingFile(override) : definition.command ? findExecutable(definition.command) : null;
    let guiInstalled = false;
    if (!override && definition.desktop) {
      if (process.platform === "darwin") guiInstalled = ["/Applications", path.join(home, "Applications")].some(root => fs.existsSync(path.join(root, definition.desktop + ".app", "Contents", "MacOS")));
      if (process.platform === "win32") {
        const executable = definition.desktop + ".exe", local = process.env.LOCALAPPDATA;
        const roots = [local, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter((value): value is string => !!value);
        guiInstalled = !!windowsAppPath(executable) || roots.some(root => ["Programs", ""].some(prefix => !!existingFile(path.join(root, prefix, definition.desktop!, executable))));
        if (!guiInstalled && id === "claude-desktop" && local) {
          const root = path.join(local, "AnthropicClaude");
          try { guiInstalled = !!existingFile(path.join(root, executable)) || fs.readdirSync(root).filter(name => /^app-\d/.test(name)).some(name => !!existingFile(path.join(root, name, executable))); } catch { /* No Squirrel installation. */ }
        }
      }
    }
    const config = fs.existsSync(filePath), installed = supported && !!(binary || guiInstalled);
    return { id, label: definition.label, configPath: filePath, supported, installed, detected: Boolean(installed || config),
      version: versions || /\.(cmd|ps1)$/i.test(binary ?? "") ? harnessVersion(binary) : null, executable: binary, restart: id === "claude-desktop" ? "desktop" as const : "terminal" as const,
      managed: config && managedConfiguration(fs.readFileSync(filePath, "utf8"), id, path.join(runtimeDir(), "plugin.mjs")) };
  });
}

export function planHarness(harness: Harness, runtimeDir: string, action: "install" | "uninstall" = "install"): FileChange {
  if (!harness.supported) throw new Error(`${harness.label} is unsupported on ${process.platform}`);
  const before = fs.existsSync(harness.configPath) ? fs.readFileSync(harness.configPath, "utf8") : null;
  const after = planConfiguration(before ?? "", { client: harness.id, action,
    version: harness.version ?? undefined, serverPath: path.join(runtimeDir, harness.id === "opencode" ? "plugin.mjs" : "mcp.mjs") });
  return { filePath: harness.configPath, before, after: action === "uninstall" && before === null ? null : after };
}
