import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { updateClientConfig } from "../../src/cli/config.js";
import { upsertCodexSkillConfig } from "../../src/cli/skills.js";

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
    assert.equal(installed.mcp["opencode-browser-plugin"].command[0], process.execPath);

    const removed = updateClientConfig({ client: "opencode-mcp", filePath: jsonPath, action: "uninstall", serverPath: "" });
    assert.equal(removed.changed, true);
    assert.equal(JSON.parse(fs.readFileSync(jsonPath, "utf8")).mcp["opencode-browser-plugin"], undefined);

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
    assert.ok(configuredToml.includes(JSON.stringify(process.execPath)));
    updateClientConfig({ client: "codex", filePath: tomlPath, action: "uninstall", serverPath: "" });
    const cleanedToml = fs.readFileSync(tomlPath, "utf8");
    assert.match(cleanedToml, /\[mcp_servers\.other\]/);
    assert.doesNotMatch(cleanedToml, /\[mcp_servers\.opencode-browser-plugin\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Older releases registered the package root itself as the plugin entry, which
// does not contain the canonical server name, so matching on that name alone
// left the stale entry in place and OpenCode loaded the plugin twice.
test("a stale package-root plugin entry is replaced, not duplicated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-cli-root-entry-"));
  try {
    const installedRoot = path.join(root, "checkout");
    fs.mkdirSync(installedRoot, { recursive: true });
    fs.writeFileSync(path.join(installedRoot, "package.json"), JSON.stringify({ name: "opencode-chromium", version: "1.7.2" }), "utf8");

    const pluginPath = path.join(root, "opencode.json");
    fs.writeFileSync(pluginPath, JSON.stringify({ plugin: [installedRoot.replaceAll("\\", "/"), "unrelated-plugin"] }), "utf8");

    const launcher = path.join(root, "launcher", "plugin.mjs");
    const canonical = pathToFileURL(path.resolve(launcher)).href;
    updateClientConfig({ client: "opencode", filePath: pluginPath, serverPath: launcher });
    assert.deepEqual(JSON.parse(fs.readFileSync(pluginPath, "utf8")).plugin, ["unrelated-plugin", canonical]);

    updateClientConfig({ client: "opencode", filePath: pluginPath, serverPath: launcher });
    assert.deepEqual(JSON.parse(fs.readFileSync(pluginPath, "utf8")).plugin, ["unrelated-plugin", canonical], "re-installing stays idempotent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Two installers append to the Codex config: the MCP section and the skills
// block. When each removed and re-appended its own block they swapped places on
// every run, so the file was rewritten, a backup was written every time, and the
// user's config reordered itself endlessly.
test("repeated installs leave the Codex config byte-identical", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-cli-codex-idempotent-"));
  try {
    const tomlPath = path.join(root, "config.toml");
    const skillPath = path.join(root, "skills", "opencode-browser-plugin", "SKILL.md");
    fs.writeFileSync(tomlPath, "model = \"m\"\n\n[mcp_servers.other]\ncommand = \"keep\"\n", "utf8");

    const install = () => {
      updateClientConfig({ client: "codex", filePath: tomlPath, serverPath: "C:/launcher/mcp.mjs" });
      const text = fs.readFileSync(tomlPath, "utf8");
      const next = upsertCodexSkillConfig(text, skillPath);
      if (next !== text) fs.writeFileSync(tomlPath, next, "utf8");
      return fs.readFileSync(tomlPath, "utf8");
    };

    const first = install();
    assert.match(first, /\[mcp_servers\.opencode-browser-plugin\]/);
    assert.match(first, /\[mcp_servers\.other\]/);
    assert.match(first, /\[\[skills\.config\]\]/);
    const position = first.indexOf("[mcp_servers.opencode-browser-plugin]");

    for (let run = 0; run < 3; run += 1) {
      assert.equal(install(), first, "an already-installed config must not be rewritten");
    }
    assert.equal(fs.readFileSync(tomlPath, "utf8").indexOf("[mcp_servers.opencode-browser-plugin]"), position, "the section must not move");
    assert.equal(updateClientConfig({ client: "codex", filePath: tomlPath, serverPath: "C:/launcher/mcp.mjs" }).changed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
