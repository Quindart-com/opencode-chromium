import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { updateClientConfig } from "../../src/cli/config.js";

test("CLI configuration updates are isolated, backed up, and idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-cli-"));
  try {
    const jsonPath = path.join(root, "opencode.json");
    fs.writeFileSync(jsonPath, JSON.stringify({ unrelated: true }), "utf8");
    const first = updateClientConfig({ client: "opencode-mcp", filePath: jsonPath, serverPath: "C:/built/server.js" });
    const second = updateClientConfig({ client: "opencode-mcp", filePath: jsonPath, serverPath: "C:/built/server.js" });
    const installed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.match(first.backup, /\.bak-/);
    assert.equal(installed.unrelated, true);
    assert.equal(installed.mcp.servers["opencode-browser-plugin"].command[0], "bun");

    const removed = updateClientConfig({ client: "opencode-mcp", filePath: jsonPath, action: "uninstall", serverPath: "" });
    assert.equal(removed.changed, true);
    assert.equal(JSON.parse(fs.readFileSync(jsonPath, "utf8")).mcp.servers["opencode-browser-plugin"], undefined);

    const pluginPath = path.join(root, "plugin.json");
    const pluginServerPath = path.join(root, "plugin.js");
    const canonicalPluginEntry = pathToFileURL(path.resolve(pluginServerPath)).href;
    const legacyPluginEntry = `file://${path.resolve(pluginServerPath).replaceAll("\\", "/")}`;
    fs.writeFileSync(pluginPath, JSON.stringify({ plugin: [
      legacyPluginEntry,
      canonicalPluginEntry,
      canonicalPluginEntry,
      "other-plugin",
    ], plugins: [legacyPluginEntry] }), "utf8");
    updateClientConfig({ client: "opencode", filePath: pluginPath, serverPath: pluginServerPath });
    const configuredPlugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
    assert.deepEqual(configuredPlugin.plugin, ["other-plugin", canonicalPluginEntry]);
    assert.equal(configuredPlugin.plugins, undefined);
    updateClientConfig({ client: "opencode", filePath: pluginPath, action: "uninstall", serverPath: pluginServerPath });
    assert.deepEqual(JSON.parse(fs.readFileSync(pluginPath, "utf8")).plugin, ["other-plugin"]);

    const tomlPath = path.join(root, "config.toml");
    fs.writeFileSync(tomlPath, "[mcp_servers.other]\ncommand = \"keep\"\n", "utf8");
    updateClientConfig({ client: "codex", filePath: tomlPath, serverPath: "C:/built/server.js" });
    const configuredToml = fs.readFileSync(tomlPath, "utf8");
    assert.match(configuredToml, /\[mcp_servers\.other\]/);
    assert.match(configuredToml, /\[mcp_servers\.opencode-browser-plugin\]/);
    assert.match(configuredToml, /command = "bun"/);
    updateClientConfig({ client: "codex", filePath: tomlPath, action: "uninstall", serverPath: "" });
    const cleanedToml = fs.readFileSync(tomlPath, "utf8");
    assert.match(cleanedToml, /\[mcp_servers\.other\]/);
    assert.doesNotMatch(cleanedToml, /\[mcp_servers\.opencode-browser-plugin\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
