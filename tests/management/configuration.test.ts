import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { planConfiguration } from "../../src/management/configuration.ts";
import { applyTransaction } from "../../src/management/transaction.ts";

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
test("Codex comments, unrelated servers, and custom timeouts survive", () => {
  const before = '# retain\n[mcp_servers.other]\ncommand="keep"\n[mcp_servers.opencode-browser-plugin]\ncommand="old"\nargs=["old"]\ntool_timeout_sec=321\n';
  const options = { client: "codex" as const, serverPath: "mcp.mjs", interpreter: "node" };
  const after = planConfiguration(before, options);
  expect(after).toContain("# retain");
  expect((parseToml(after).mcp_servers as Record<string, Record<string, unknown>>)["opencode-browser-plugin"]?.tool_timeout_sec).toBe(321);
  expect(planConfiguration(after, options)).toBe(after);
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
