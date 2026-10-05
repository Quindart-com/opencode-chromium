import { test, expect } from "bun:test";
import { parseDocument } from "yaml";
import { planConfiguration } from "../../src/management/configuration.ts";
import { detectHarnesses } from "../../src/management/harnesses.ts";
import { deepSeekManaged } from "../../src/management/deepseek.ts";

const options = { client: "dsh" as const, serverPath: "C:\\runtime\\mcp.mjs", interpreter: "node" };
test("DeepSeek migrates existing browser config, preserves expressions and custom settings, and is idempotent", () => {
  const before = '# keep\n- id: mcp-browser\n  config:\n    serverName: browser\n    transport: stdio\n    command: old\n    args: [old.mjs]\n    toolCallTimeoutMs: 321000\n- id: connection\n  config:\n    trustedHosts: !!js ctx.webRuntime.trustedHosts\n';
  const after = planConfiguration(before, options);
  expect(after).toContain("# keep");
  expect(after).toContain("!!js ctx.webRuntime.trustedHosts");
  const rows = parseDocument(after, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (s: string) => s }] }).toJS();
  expect(rows[0].config.args).toEqual([options.serverPath]);
  expect(rows[0].config.toolCallTimeoutMs).toBe(321000);
  expect(rows[0].config.serverName).toBe("browser");
  expect(planConfiguration(after, options)).toBe(after);
  const removed = planConfiguration(after, { ...options, action: "uninstall" });
  expect(removed).toContain("disabled: true");
  expect(deepSeekManaged(after)).toBe(true);
  expect(deepSeekManaged(removed)).toBe(false);
  expect(planConfiguration(removed, { ...options, action: "uninstall" })).toBe(removed);
  expect(removed).toContain("!!js ctx.webRuntime.trustedHosts");
});
test("DeepSeek installs an MCP client row in an empty patch and removes only that row", () => {
  const after = planConfiguration("", options);
  expect(after).toContain("@deepseek-ai/dsh-mcp-client");
  expect(planConfiguration(after, options)).toBe(after);
  expect(parseDocument(planConfiguration(after, { ...options, action: "uninstall" })).toJS()).toEqual([]);
});
test("DeepSeek rejects malformed or duplicate owned rows", () => {
  for (const before of ["{broken", "{}", "- id: mcp-browser\n  config: []", "- id: mcp-browser\n- id: mcp-opencode-browser-plugin\n"]) {
    expect(() => planConfiguration(before, options)).toThrow();
  }
});
test("DeepSeek discovery honors DSH_HOME", () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = "C:/custom-dsh";
  try { expect(detectHarnesses().find(row => row.id === "dsh")?.configPath.replaceAll("\\", "/")).toBe("C:/custom-dsh/profiles/web/cordis.patch.yml"); }
  finally { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; }
});
