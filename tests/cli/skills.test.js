import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  cleanCodexSkillConfig,
  codexConfigPath,
  directoryHash,
  installSkills,
  skillSourceDirectory,
  skillTargets,
  uninstallSkills,
  upsertCodexSkillConfig,
} from "../../src/cli/skills.js";

test("canonical skill conforms to the agent-skills spec", () => {
  const source = skillSourceDirectory();
  const text = fs.readFileSync(path.join(source, "SKILL.md"), "utf8");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter, "SKILL.md must start with YAML frontmatter");
  const meta = parseYaml(frontmatter[1]);
  assert.equal(meta.name, "opencode-browser-plugin");
  assert.match(meta.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(meta.name, path.basename(source));
  assert.ok(meta.description?.length >= 1 && meta.description?.length <= 1024, "description must be present and within 1-1024 chars");
  assert.ok(text.length > meta.description.length, "SKILL.md body must contain instructions");
});

test("agents/openai.yaml is valid and declares the connector", () => {
  const file = path.join(skillSourceDirectory(), "agents", "openai.yaml");
  const doc = parseYaml(fs.readFileSync(file, "utf8"));
  assert.equal(doc.interface.display_name, "OpenCode Browser Plugin");
  assert.equal(doc.policy.allow_implicit_invocation, true);
  const dep = doc.dependencies.tools[0];
  assert.equal(dep.type, "mcp");
  assert.equal(dep.value, "opencode-browser-plugin");
  assert.equal(dep.transport, "stdio");
});

test("codex skill config toml edits preserve unrelated entries and remove stale ones", () => {
  const seed = `[mcp_servers.other]
command = "keep"

[[skills.config]]
path = 'C:\\x\\playwright\\SKILL.md'
enabled = false

[[skills.config]]
path = 'C:\\x\\Opencode-Plugins\\.opencode\\skills\\opencode-browser-adapter\\SKILL.md'
enabled = true
`;
  const updated = upsertCodexSkillConfig(seed, "C:/tmp/.codex/skills/opencode-browser-plugin/SKILL.md");
  assert.match(updated, /\[mcp_servers\.other\]/);
  assert.match(updated, /playwright/);
  assert.doesNotMatch(updated, /opencode-browser-adapter/);
  assert.match(updated, /path = "C:\\\\tmp\\\\.codex\\\\skills\\\\opencode-browser-plugin\\\\SKILL\.md"/);
  assert.match(updated, /enabled = true/);

  const cleaned = cleanCodexSkillConfig(updated);
  assert.match(cleaned, /\[mcp_servers\.other\]/);
  assert.match(cleaned, /playwright/);
  assert.doesNotMatch(cleaned, /opencode-browser-plugin/);
  assert.doesNotMatch(cleaned, /opencode-browser-adapter/);
});

test("skills install lands in all standard homes and fixes the codex config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-skills-"));
  try {
    const codexDir = path.join(root, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, "config.toml");
    fs.writeFileSync(configPath, `[mcp_servers.other]\ncommand = "keep"\n\n[[skills.config]]\npath = 'C:\\x\\Opencode-Plugins\\.opencode\\skills\\opencode-browser-adapter\\SKILL.md'\nenabled = true\n`, "utf8");

    const result = installSkills({ homedir: root });
    assert.equal(result.dryRun, false);
    assert.equal(result.changed, true);
    assert.ok(result.backups.length >= 1, "codex config must be backed up");

    const targets = skillTargets(root);
    const canonical = directoryHash(skillSourceDirectory());
    for (const target of targets) {
      assert.ok(fs.existsSync(path.join(target, "SKILL.md")), `missing skill at ${target}`);
      assert.equal(directoryHash(target).sha256, canonical.sha256, `parity failed at ${target}`);
    }

    const updated = fs.readFileSync(configPath, "utf8");
    assert.match(updated, /\[mcp_servers\.other\]/);
    assert.doesNotMatch(updated, /opencode-browser-adapter/);
    assert.match(updated, /opencode-browser-plugin/);
    assert.match(updated, /enabled = true/);

    const second = installSkills({ homedir: root });
    assert.equal(second.changed, false, "a second install must be a no-op");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills dry-run makes no changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-skills-"));
  try {
    const result = installSkills({ homedir: root, dryRun: true });
    assert.equal(result.dryRun, true);
    for (const target of skillTargets(root)) assert.ok(!fs.existsSync(target), `dry-run created ${target}`);
    assert.ok(!fs.existsSync(codexConfigPath(root)), "dry-run wrote the codex config");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skills uninstall removes only the plugin skill and its config entry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-skills-"));
  try {
    installSkills({ homedir: root });
    const unrelated = path.join(root, ".claude", "skills", "other-skill", "SKILL.md");
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fs.writeFileSync(unrelated, "---\nname: other-skill\ndescription: keep me\n---\n", "utf8");

    const result = uninstallSkills({ homedir: root });
    assert.equal(result.changed, true);
    for (const target of skillTargets(root)) assert.ok(!fs.existsSync(target), `uninstall left ${target}`);
    assert.ok(fs.existsSync(unrelated), "unrelated skill must survive");
    const config = fs.readFileSync(codexConfigPath(root), "utf8");
    assert.doesNotMatch(config, /opencode-browser-plugin/);
    assert.doesNotMatch(config, /opencode-browser-adapter/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});