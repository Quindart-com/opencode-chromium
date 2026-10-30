import { expect,test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectHarnesses } from "../../src/management/harnesses.ts";
import { harnessConfigPath } from "../../src/management/harness-paths.ts";
import { harnessEnv,harnessTargets } from "../../src/shared/harnesses.ts";
import { configPath } from "../../src/cli/config.ts";
import { browserUserDataRoot,executableCandidates } from "../../src/cli/browsers.ts";

test("custom executable discovery distinguishes installations from stale configuration and shares config overrides with the CLI", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-discovery-"));
  const values: Record<string, string | undefined> = {};
  const set = (key: string, value: string) => { values[key] = process.env[key]; process.env[key] = value; };
  try {
    for (const id of harnessTargets) {
      set(harnessEnv(id, "EXECUTABLE"), path.join(root, "absent-" + id));
      set(harnessEnv(id, "CONFIG"), path.join(root, id + ".json"));
    }
    fs.writeFileSync(harnessConfigPath("codex"), "# old installation\n");
    const binary = path.join(root, "custom-opencode.exe"); fs.writeFileSync(binary, "fixture");
    process.env[harnessEnv("opencode", "EXECUTABLE")] = binary;
    let rows = detectHarnesses(root, { versions: false });
    expect(rows.find(row => row.id === "codex")).toMatchObject({ detected: true, installed: false });
    expect(rows.find(row => row.id === "opencode")).toMatchObject({ installed: true, executable: binary });
    expect(configPath("opencode")).toBe(harnessConfigPath("opencode"));
    const desktop = path.join(root, "custom-claude-desktop.exe"); fs.writeFileSync(desktop, "fixture");
    process.env[harnessEnv("claude-desktop", "EXECUTABLE")] = desktop;
    rows = detectHarnesses(root, { versions: false });
    expect(rows.find(row => row.id === "claude-desktop")?.installed).toBe(true);
    expect(rows.find(row => row.id === "claude-code")?.installed).toBe(false);
    set("OPENCODE_BROWSER_BRAVE_EXECUTABLE", binary);
    set("OPENCODE_BROWSER_BRAVE_USER_DATA_DIR", path.join(root, "browser-profile"));
    expect(executableCandidates("brave")).toEqual([binary]);
    expect(browserUserDataRoot("brave")).toBe(path.join(root, "browser-profile"));
    process.env.OPENCODE_BROWSER_BRAVE_EXECUTABLE = path.join(root, "absent");
    expect(executableCandidates("brave")).toEqual([]);
  } finally {
    for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toStartWith("browser-discovery-");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("standard harness environment paths and explicit custom OpenCode config remain consistent", () => {
  const keys = ["CODEX_HOME", "DSH_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "OPENCODE_CONFIG", ...harnessTargets.map(id => harnessEnv(id, "CONFIG"))];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const root = path.join(os.tmpdir(), "discovery-paths");
  try {
    for (const key of keys) delete process.env[key];
    process.env.CODEX_HOME = path.join(root, "codex"); process.env.DSH_HOME = path.join(root, "deepseek");
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude"); process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
    expect(configPath("codex")).toBe(path.join(root, "codex/config.toml"));
    expect(configPath("dsh")).toBe(path.join(root, "deepseek/profiles/web/cordis.patch.yml"));
    expect(configPath("claude-code")).toBe(path.join(root, "claude/.claude.json"));
    expect(configPath("opencode")).toBe(path.join(root, "xdg/opencode/opencode.json"));
    process.env.OPENCODE_CONFIG = path.join(root, "custom.jsonc");
    expect(configPath("opencode")).toBe(process.env.OPENCODE_CONFIG);
    expect(configPath("opencode-mcp")).toBe(process.env.OPENCODE_CONFIG);
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
