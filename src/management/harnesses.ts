import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimeDir } from "../cli/native-host.ts";
import { record } from "../shared/values.ts";
import { type HarnessId,managedConfiguration,planConfiguration } from "./configuration.ts";
import type { FileChange } from "./transaction.js";

export interface Harness {
  id: HarnessId;
  label: string;
  detected: boolean;
  version: string | null;
  configPath: string;
  supported: boolean;
  restart: "desktop" | "terminal";
  executable: string | null;
  managed: boolean;
}
function executable(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const suffix of process.platform === "win32" ? [".exe", ".cmd", ".ps1", ""] : [""]) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), name + suffix);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* absent */ }
    }
  }
  return null;
}
export function harnessVersion(binary: string | null): string | null {
  if (!binary) return null;
  if (/\.(cmd|ps1)$/.test(binary)) {
    const command = path.basename(binary).replace(/\.(cmd|ps1)$/, "");
    const packages = ({ opencode: ["@opencode/cli", "opencode-ai"], codex: ["@openai/codex"], claude: ["@anthropic-ai/claude-code"], dsh: ["@deepseek-ai/dsh"] } as Record<string, string[]>)[command] ?? [];
    for (const packageName of packages) {
      try { return record(JSON.parse(fs.readFileSync(path.join(path.dirname(binary), "node_modules", packageName, "package.json"), "utf8")) as unknown).version as string; } catch { /* Try the supported legacy package. */ }
    }
    return null;
  }
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
  return result.status === 0 ? result.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null : null;
}
export function detectHarnesses(home = os.homedir(), { versions = true } = {}): Harness[] {
  const platform = process.platform;
  const desktop = platform === "win32" ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude") : path.join(home, "Library", "Application Support", "Claude");
  const specs: Array<[HarnessId, string, string, string, boolean]> = [
    ["codex", "Codex CLI / Desktop", "codex", path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml"), true],
    ["opencode", "OpenCode", "opencode", path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode", "opencode.json"), true],
    ["dsh", "DeepSeek Harness", "dsh", path.join(process.env.DSH_HOME ?? path.join(home, ".dsh"), "profiles", "web", "cordis.patch.yml"), true],
    ["claude-code", "Claude Code", "claude", path.join(process.env.CLAUDE_CONFIG_DIR ?? home, ".claude.json"), true],
    ["claude-desktop", "Claude Desktop", "", path.join(desktop, "claude_desktop_config.json"), platform !== "linux"],
  ];
  return specs.map(([id, label, command, filePath, supported]) => {
    if (id === "opencode" && fs.existsSync(filePath + "c")) filePath += "c";
    const binary = command ? executable(command) : null;
    const config = fs.existsSync(filePath);
    const guiPath = id === "claude-desktop" ? platform === "darwin" ? "/Applications/Claude.app" : path.join(process.env.LOCALAPPDATA ?? "", "AnthropicClaude") : id === "codex" ? platform === "darwin" ? "/Applications/Codex.app" : path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Codex") : "";
    return { id, label, configPath: filePath, supported, detected: Boolean(binary || config || guiPath && fs.existsSync(guiPath)),
      version: versions || /\.(cmd|ps1)$/i.test(binary ?? "") ? harnessVersion(binary) : null, executable: binary, restart: id === "claude-desktop" ? "desktop" : "terminal",
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
