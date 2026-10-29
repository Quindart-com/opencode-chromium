import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { manageSetup, formatSetupResult } from "../../src/management/setup.ts";
import type { Harness } from "../../src/management/harnesses.ts";
import { directoryHash,inspectHarnessSkills } from "../../src/cli/skills.ts";
import { planSkills } from "../../src/management/skills.ts";
import { applyTransaction } from "../../src/management/transaction.ts";
import { managedConfiguration } from "../../src/management/configuration.ts";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-setup-flow-"));
  const root = path.join(home, "package"), dir = path.join(home, "runtime");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist/build-manifest.json"), "{}");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.9.2" }));
  fs.cpSync(path.join(process.cwd(), "skills"), path.join(root, "skills"), { recursive: true });
  const specs = [
    ["codex", path.join(home, ".codex/config.toml"), '# keep model\nmodel = "chosen"\n[mcp_servers.other]\ncommand = "keep"\n'],
    ["opencode", path.join(home, ".config/opencode/opencode.jsonc"), '{\n // keep preference\n "theme": "system", "plugins": ["other"]\n}'],
    ["claude-code", path.join(home, ".claude.json"), '{"mcpServers":{"other":{"command":"keep"}}}'],
    ["claude-desktop", path.join(home, "Claude/claude_desktop_config.json"), '{"mcpServers":{"other":{"command":"keep"}}}'],
    ["dsh", path.join(home, ".dsh/profiles/web/cordis.patch.yml"), "[]\n"],
  ];
  const rows: Harness[] = specs.map(([id, configPath, text]) => {
    fs.mkdirSync(path.dirname(configPath!), { recursive: true }); fs.writeFileSync(configPath!, text!);
    return { id: id as Harness["id"], label: id!, configPath: configPath!, detected: true, supported: true, managed: false,
      executable: null, version: id === "opencode" ? "2.0.0" : "1.0.0", restart: "terminal" };
  });
  const hostPath = path.join(dir, "native-host-launcher"), registration = path.join(dir, "native-manifest.json");
  let registrations = 0, restarts = 0;
  const environment = { home, root, dir, rows,
    planHosts: () => ({ hostPath, registry: [], changes: [hostPath, registration].map(filePath => ({ filePath,
      before: fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null, after: "local native host fixture\n" })) }),
    registerHosts: () => { registrations++; }, restart: async () => { restarts++; return []; } };
  return { home, root, dir, rows, registration, environment, counters: () => ({ registrations, restarts }) };
}

test("targeted setup previews all changes, registers a host, preserves unrelated config, and stays idempotent", async () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.rows[0]!.configPath, "utf8");
    const preview = await manageSetup(["--targets", "codex", "--dry-run", "--json"], false, f.environment);
    expect(fs.readFileSync(f.rows[0]!.configPath, "utf8")).toBe(before);
    expect(fs.existsSync(f.dir)).toBe(false);
    expect(f.counters()).toEqual({ registrations: 0, restarts: 0 });
    expect(formatSetupResult(preview)).toContain("would change");
    expect(preview.browserSetup).toStartWith("Will register");
    const first = await manageSetup(["--targets", "codex", "--json"], false, f.environment);
    expect(first.targets).toEqual(["codex"]);
    expect(first.backups).toHaveLength(1);
    expect(fs.existsSync(f.registration)).toBe(true);
    const installed = parseToml(fs.readFileSync(f.rows[0]!.configPath, "utf8"));
    expect(installed.model).toBe("chosen");
    expect((installed.mcp_servers as Record<string, Record<string, unknown>>).other?.command).toBe("keep");
    expect(fs.existsSync(path.join(f.home, ".codex/skills/opencode-browser-plugin/SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(f.home, ".claude"))).toBe(false);
    const second = await manageSetup(["--targets", " codex,codex ", "--json"], false, f.environment);
    expect(second.changedFiles).toEqual([]);
    expect(second.backups).toEqual([]);
    expect(formatSetupResult(second)).toStartWith("Already up to date");
    const rows = f.rows.map(row => ({ ...row, managed: managedConfiguration(fs.readFileSync(row.configPath, "utf8"), row.id, path.join(f.dir, "plugin.mjs")) }));
    const health = inspectHarnessSkills({ harnesses: rows, homedir: f.home, source: path.join(f.root, "skills/opencode-browser-plugin") });
    expect(health.clients).toEqual(["codex"]);
    expect(health.skills).toHaveLength(1);
    expect(health.skills.every(skill => skill.installed && skill.parity)).toBe(true);
    expect(health.codexEnabled).toBe(true);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test("setup --all connects only detected supported apps and uninstall leaves browser registration in place", async () => {
  const f = fixture();
  try {
    f.rows[3]!.supported = false; f.rows[4]!.detected = false;
    const untouched = f.rows.slice(3).map(row => fs.readFileSync(row.configPath, "utf8"));
    const first = await manageSetup(["--all", "--json"], false, f.environment);
    expect(first.targets).toEqual(["codex", "opencode", "claude-code"]);
    expect(f.rows.slice(3).map(row => fs.readFileSync(row.configPath, "utf8"))).toEqual(untouched);
    expect(fs.readFileSync(f.rows[1]!.configPath, "utf8")).toContain('"theme": "system"');
    const installed = await manageSetup(["--all", "--json"], false, f.environment);
    expect(installed.changedFiles).toEqual([]);
    await manageSetup(["--targets", "codex,opencode,claude-code", "--json"], true, f.environment);
    expect(fs.existsSync(f.registration)).toBe(true);
    expect((parseToml(fs.readFileSync(f.rows[0]!.configPath, "utf8")).mcp_servers as Record<string, unknown>)["opencode-browser-plugin"]).toBeUndefined();
    expect(fs.existsSync(path.join(f.home, ".codex/skills/opencode-browser-plugin/SKILL.md"))).toBe(false);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test("setup preserves an enabled native Codex plugin without adding duplicate MCP tools or skills", async () => {
  const f = fixture();
  try {
    fs.appendFileSync(f.rows[0]!.configPath, '[plugins."opencode-browser-plugin@quindart-browser"]\nenabled = true\n');
    const result = await manageSetup(["--targets", "codex", "--json"], false, f.environment);
    expect(result.nativePlugins).toEqual(["codex"]);
    expect(fs.existsSync(path.join(f.home, ".codex/skills"))).toBe(false);
    const config = parseToml(fs.readFileSync(f.rows[0]!.configPath, "utf8"));
    expect((config.mcp_servers as Record<string, unknown>)["opencode-browser-plugin"]).toBeUndefined();
    expect((config.plugins as Record<string, Record<string, unknown>>)["opencode-browser-plugin@quindart-browser"]?.enabled).toBe(true);
    expect(formatSetupResult(result)).toContain("native browser plugin");
    expect(result.pluginUpdates).toMatchObject([{ id: "codex", command: "codex plugin marketplace upgrade quindart-browser" }]);
    expect(formatSetupResult(result)).toContain("codex plugin marketplace upgrade quindart-browser");
    const health = inspectHarnessSkills({ harnesses: [{ ...f.rows[0]!, managed: true }], homedir: f.home, source: path.join(f.root, "skills/opencode-browser-plugin") });
    expect(health.clients).toEqual(["codex"]);
    expect(health.nativePlugins).toEqual(["codex"]);
    expect(health.skills).toEqual([]);
    expect(health.codexEnabled).toBe(true);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test("skill health catches an explicitly disabled or stale Codex browser skill", async () => {
  const f = fixture();
  try {
    await manageSetup(["--targets", "codex", "--json"], false, f.environment);
    const harnesses = [{ ...f.rows[0]!, managed: true }];
    const options = { harnesses, homedir: f.home, source: path.join(f.root, "skills/opencode-browser-plugin") };
    fs.appendFileSync(f.rows[0]!.configPath, '[[skills.config]]\npath="opencode-browser-plugin/SKILL.md"\nenabled=false\n');
    expect(inspectHarnessSkills(options).codexEnabled).toBe(false);
    fs.appendFileSync(path.join(f.home, ".codex/skills/opencode-browser-plugin/SKILL.md"), "\nold content");
    expect(inspectHarnessSkills(options).skills[0]!.parity).toBe(false);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test("setup --all recognizes an existing custom configuration without requiring a default config", async () => {
  const f = fixture();
  try {
    for (const row of f.rows) row.detected = false;
    const custom = path.join(f.home, "custom-codex.toml");
    fs.writeFileSync(custom, '# custom preference\nmodel = "chosen"\n');
    const result = await manageSetup(["--all", "--config", "codex=" + custom, "--json"], false, f.environment);
    expect(result.targets).toEqual(["codex"]);
    expect(parseToml(fs.readFileSync(custom, "utf8")).model).toBe("chosen");
    expect(fs.readFileSync(f.rows[0]!.configPath, "utf8")).not.toContain("[mcp_servers.opencode-browser-plugin]");
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test("invalid targets and a failing native registration leave all harness configs unchanged", async () => {
  const f = fixture();
  try {
    const before = f.rows.map(row => fs.readFileSync(row.configPath, "utf8"));
    for (const args of [["--targets"], ["--targets", "--json"], ["--targets", "codex,"], ["--all", "--targets", "codex"], ["--targets", "unknown"]]) {
      await expect(manageSetup(args, false, f.environment)).rejects.toThrow();
    }
    await expect(manageSetup(["--all", "--json"], false, { ...f.environment, registerHosts: () => { throw new Error("fixture registration failure"); } })).rejects.toThrow("rolled back");
    expect(f.rows.map(row => fs.readFileSync(row.configPath, "utf8"))).toEqual(before);
    expect(fs.existsSync(f.registration)).toBe(false);
    expect(fs.existsSync(path.join(f.dir, "runtime.json"))).toBe(false);
    expect(fs.existsSync(path.join(f.home, ".codex/skills/opencode-browser-plugin/SKILL.md"))).toBe(false);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});

test("setup help is noninteractive and never creates runtime or client files", () => {
  const f = fixture();
  try {
    const before = f.rows.map(row => fs.readFileSync(row.configPath, "utf8"));
    const output = execFileSync(process.execPath, [path.join(process.cwd(), "src/cli/index.ts"), "setup", "--help"], {
      encoding: "utf8", timeout: 15000, windowsHide: true,
      env: { ...process.env, OPENCODE_BROWSER_RUNTIME_DIR: f.dir, CODEX_HOME: path.join(f.home, ".codex") },
    });
    expect(output).toContain("setup --all");
    expect(output).toContain("--dry-run");
    expect(f.rows.map(row => fs.readFileSync(row.configPath, "utf8"))).toEqual(before);
    expect(fs.existsSync(f.dir)).toBe(false);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
}, 20000);

test("skill upgrades retain transaction backups without reporting them as stale instructions", () => {
  const f = fixture();
  try {
    const source = path.join(f.root, "skills/opencode-browser-plugin");
    applyTransaction(planSkills(f.root, ["opencode"], false, f.home));
    fs.appendFileSync(path.join(source, "SKILL.md"), "\nUpdated recovery guidance.\n");
    const applied = applyTransaction(planSkills(f.root, ["opencode"], false, f.home));
    expect(applied.backups.length).toBeGreaterThan(0);
    expect(applied.backups.every(file => fs.existsSync(file))).toBe(true);
    const target = path.join(f.home, ".agents/skills/opencode-browser-plugin");
    expect(directoryHash(target).sha256).toBe(directoryHash(source).sha256);
    fs.appendFileSync(path.join(target, "SKILL.md"), "\nStale edit.\n");
    expect(directoryHash(target).sha256).not.toBe(directoryHash(source).sha256);
  } finally { fs.rmSync(f.home, { recursive: true, force: true }); }
});
