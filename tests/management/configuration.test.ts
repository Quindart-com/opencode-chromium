import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { planConfiguration, nativeCodexPluginEnabled, managedConfiguration } from "../../src/management/configuration.ts";
import { applyTransaction } from "../../src/management/transaction.ts";
import { harnessVersion } from "../../src/management/harnesses.ts";
import { linkClientSurfaces } from "../../src/cli/runtime-link.ts";

test("setup preserves direct Codex MCP recovery when the skill plugin's bundled server is explicitly disabled", () => {
  const before = '[plugins."opencode-browser-plugin@quindart-browser"]\nenabled = true\n' +
    '[plugins."opencode-browser-plugin@quindart-browser".mcp_servers.opencode-browser-plugin]\nenabled = false\n' +
    '[mcp_servers.opencode-browser-plugin]\ncommand = "node"\nargs = ["/runtime/mcp.mjs"]\nstartup_timeout_sec = 60\n';
  expect(nativeCodexPluginEnabled(before)).toBe(true);
  expect(managedConfiguration(before, "codex")).toBe(true);
  const options = { client: "codex" as const, serverPath: "/runtime/mcp.mjs", interpreter: "node" };
  expect(planConfiguration(before, options)).toBe(before);
  const changed = planConfiguration(before, { ...options, serverPath: "/new-runtime/mcp.mjs" });
  expect((parseToml(changed).mcp_servers as Record<string, { startup_timeout_sec: number }>)["opencode-browser-plugin"]!.startup_timeout_sec).toBe(60);
  const removed = planConfiguration(before, { ...options, action: "uninstall" });
  expect(managedConfiguration(removed, "codex")).toBe(false);
});

test("JSONC comments survive native/MCP migration and repeated setup", () => {
  const before = '{\n // retain my comment\n "plugins": ["opencode-chromium@1.7.2", "other"],\n "mcp": {"opencode-browser-plugin": {"type":"local"}}\n}';
  const options = { client: "opencode" as const, serverPath: path.resolve("plugin.mjs"), version: "2.0.0" };
  const after = planConfiguration(before, options);
  expect(after).toContain("// retain my comment");
  expect(parse(after).plugins).toHaveLength(2);
  expect(parse(after).mcp["opencode-browser-plugin"]).toBeUndefined();
  expect(planConfiguration(after, options)).toBe(after);
});
test("malformed configurations cannot be planned", () => {
  expect(() => planConfiguration('{broken', { client: "opencode", serverPath: "x" })).toThrow();
  expect(() => planConfiguration('[invalid', { client: "codex", serverPath: "x" })).toThrow();
});

test("OpenCode V2 migrates file launchers to one directory and detects its current Windows package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-v2-detect-"));
  try {
    const pkg = path.join(root, "node_modules/@opencode/cli"); fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), '{"version":"2.0.30"}');
    expect(harnessVersion(path.join(root, "opencode.ps1"))).toBe("2.0.30");
    const serverPath = path.join(root, "runtime/plugin.mjs");
    const after = planConfiguration(JSON.stringify({ plugin: ["other", serverPath], plugins: [path.join(root, "runtime/v2")] }), { client: "opencode", serverPath, version: "2.0.30" });
    expect(parse(after).plugins).toEqual(["other", pathToFileURL(path.join(root, "runtime/v2")).href]);
    expect(parse(after).plugin).toBeUndefined();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("Codex comments, unrelated servers, and custom timeouts survive", () => {
  const before = '# retain\n[mcp_servers.other]\ncommand="keep"\n[mcp_servers.opencode-browser-plugin]\ncommand="old"\nargs=["old"]\ntool_timeout_sec=321\n';
  const options = { client: "codex" as const, serverPath: "mcp.mjs", interpreter: "node" };
  const after = planConfiguration(before, options);
  expect(after).toContain("# retain");
  expect((parseToml(after).mcp_servers as Record<string, Record<string, unknown>>)["opencode-browser-plugin"]?.tool_timeout_sec).toBe(321);
  expect(planConfiguration(after, options)).toBe(after);
});

test("Codex quoted server names and nested settings migrate and uninstall without orphan tables", () => {
  const unrelated = '[mcp_servers.other]\ncommand = "keep"\n# unrelated comment\n';
  const before = '# preferences\nmodel = "chosen"\n[mcp_servers."opencode-browser-plugin"]\ncommand="old"\nargs=["old"]\ntool_timeout_sec=321\n[mcp_servers."opencode-browser-plugin".env]\nBROWSER_LABEL="Work"\n' + unrelated;
  const options = { client: "codex" as const, serverPath: "mcp.mjs", interpreter: "node" };
  const after = planConfiguration(before, options);
  const installed = (parseToml(after).mcp_servers as Record<string, Record<string, unknown>>)["opencode-browser-plugin"]!;
  expect(installed.env).toEqual({ BROWSER_LABEL: "Work" });
  expect(installed.tool_timeout_sec).toBe(321);
  expect(after).toContain(unrelated);
  expect(planConfiguration(after, options)).toBe(after);
  const removed = planConfiguration(after, { ...options, action: "uninstall" });
  expect((parseToml(removed).mcp_servers as Record<string, unknown>)["opencode-browser-plugin"]).toBeUndefined();
  expect(removed).toContain(unrelated);
});

test("a TOML multiline value cannot masquerade as an owned server header", () => {
  const before = 'description = """\n[mcp_servers.opencode-browser-plugin]\nexample text\n"""\n[mcp_servers.other]\ncommand = "keep"\n';
  const options = { client: "codex" as const, serverPath: "mcp.mjs", interpreter: "node" };
  const after = planConfiguration(before, options);
  expect(after).toStartWith(before);
  expect(planConfiguration(after, { ...options, action: "uninstall" })).toBe(before);
});

test("enabled native Codex plugins avoid duplicate manual MCP registration", () => {
  const plugin = '[plugins."opencode-browser-plugin@quindart-browser"]\nenabled = true\n';
  const options = { client: "codex" as const, serverPath: "mcp.mjs" };
  expect(nativeCodexPluginEnabled(plugin)).toBe(true);
  expect(planConfiguration(plugin, options)).toBe(plugin);
  const duplicate = plugin + '[mcp_servers.opencode-browser-plugin]\ncommand="old"\nargs=["old"]\n[mcp_servers.opencode-browser-plugin.env]\nBROWSER_LABEL="Work"\n';
  expect(planConfiguration(duplicate, options)).toBe(plugin);
  const disabled = plugin.replace("true", "false");
  expect(nativeCodexPluginEnabled(disabled)).toBe(false);
  expect((parseToml(planConfiguration(disabled, options)).mcp_servers as Record<string, unknown>)["opencode-browser-plugin"]).toBeDefined();
});

test("managed discovery recognizes stable OpenCode launchers and ignores comments mentioning the plugin", () => {
  const serverPath = path.resolve("runtime/plugin.mjs");
  const configured = planConfiguration("{}", { client: "opencode", serverPath, version: "2.0.0" });
  expect(managedConfiguration(configured, "opencode", serverPath)).toBe(true);
  expect(managedConfiguration('{\n// opencode-browser-plugin example\n"plugins":["other"]\n}', "opencode", serverPath)).toBe(false);
  expect(managedConfiguration('# opencode-browser-plugin example\nmodel="chosen"\n', "codex")).toBe(false);
  expect(managedConfiguration('{"mcpServers":{"opencode-browser-plugin":{"command":"node"}}}', "claude-code")).toBe(true);
});
test("Claude registrations preserve unrelated servers", () => {
  const before = '{"mcpServers":{"other":{"command":"keep"}}}';
  const options = { client: "claude-code" as const, serverPath: "mcp.mjs" };
  const after = planConfiguration(before, options);
  expect(parse(after).mcpServers.other.command).toBe("keep");
  expect(planConfiguration(after, options)).toBe(after);
});
test("dry run preserves files; conflicting edit rolls back earlier writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-transaction-"));
  try {
    const a = path.join(root, "a"), b = path.join(root, "b");
    fs.writeFileSync(a, "original"); fs.writeFileSync(b, "concurrent change");
    const changes = [{ filePath: a, before: "original", after: "new" }, { filePath: b, before: "old", after: "new" }];
    applyTransaction(changes, true);
    expect(fs.readFileSync(a, "utf8")).toBe("original");
    expect(() => applyTransaction(changes)).toThrow("rolled back");
    expect(fs.readFileSync(a, "utf8")).toBe("original");
    expect(fs.readFileSync(b, "utf8")).toBe("concurrent change");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("OpenCode 2.3.2 plan points plugins at the v2 directory of the launcher", () => {
  const serverPath = path.join(os.tmpdir(), "runtime", "plugin.mjs");
  const after = planConfiguration("{}", { client: "opencode", serverPath, version: "2.3.2" });
  expect(parse(after).plugins).toEqual([pathToFileURL(path.join(os.tmpdir(), "runtime", "v2")).href]);
  expect(parse(after).plugin).toBeUndefined();
});

test("link passes the installed OpenCode version and writes the v2 wrapper", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-link-v2-"));
  const config = path.join(root, "opencode.json");
  const saved = process.env.OPENCODE_BROWSER_OPENCODE_CONFIG;
  process.env.OPENCODE_BROWSER_OPENCODE_CONFIG = config;
  try {
    const result = linkClientSurfaces({ dir: path.join(root, "runtime"), clients: ["opencode"], openCodeVersion: "2.3.2" });
    expect(parse(fs.readFileSync(config, "utf8")).plugins).toEqual([pathToFileURL(path.join(root, "runtime", "v2")).href]);
    expect(fs.readFileSync(path.join(root, "runtime", "v2", "index.ts"), "utf8")).toContain("../plugin.mjs");
    expect(result.results).toHaveLength(1);
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_BROWSER_OPENCODE_CONFIG; else process.env.OPENCODE_BROWSER_OPENCODE_CONFIG = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
