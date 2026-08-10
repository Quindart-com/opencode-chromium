import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createBrowserAgent } from "../adapters/sdk/index.js";
import { createCapabilityRegistry } from "../core/capabilities.js";
import { packageInfo } from "./version.js";
import { codexConfigPath, directoryHash, skillSourceDirectory, skillTargets, STALE_SKILL_MARKER } from "./skills.js";

function check(name, ok, details = {}) {
  return { name, ok: Boolean(ok), ...details };
}

export async function runDoctor({ json = false } = {}) {
  const info = packageInfo();
  const dist = path.join(info.root, "dist");
  const artifactDir = process.env.AGENT_BROWSER_ARTIFACT_DIR ?? process.env.OPENCODE_BROWSER_ARTIFACT_DIR ?? path.join(os.tmpdir(), "opencode-browser-plugin-artifacts");
  const agent = createBrowserAgent();
  let tools;
  try {
    tools = agent.tools("mcp");
  } finally {
    agent.close();
  }
  const checks = [
    check("node", Number.parseInt(process.versions.node, 10) >= 20, { version: process.versions.node }),
    check("bun", Boolean(process.versions.bun), { version: process.versions.bun ?? null }),
    check("package", info.name === "opencode-browser-plugin" && info.version === "1.1.0", { name: info.name, version: info.version }),
    check("build", fs.existsSync(path.join(dist, "build-manifest.json")), { path: "dist" }),
    check("four-tools", tools.length === 4, { tools: tools.map((tool) => tool.name) }),
    check("artifact-directory", (() => { try { fs.mkdirSync(artifactDir, { recursive: true }); return fs.statSync(artifactDir).isDirectory(); } catch { return false; } })(), { configured: Boolean(process.env.AGENT_BROWSER_ARTIFACT_DIR ?? process.env.OPENCODE_BROWSER_ARTIFACT_DIR) }),
    check("extension", fs.existsSync(path.join(info.root, "extension", "manifest.json")), { installed: false, message: "Use check:extension for browser-profile discovery." }),
    check("native-host", fs.existsSync(path.join(info.root, "native-host", "src", "host.js")), { installed: false, message: "Use install:native-host to register the host." }),
    check("semantic-cache", true, { configured: Boolean(process.env.AGENT_BROWSER_SEMANTIC_DIR ?? process.env.OPENCODE_BROWSER_SEMANTIC_DIR) }),
    check("qwen-cache", true, { configured: Boolean(process.env.AGENT_BROWSER_SEMANTIC_DIR ?? process.env.OPENCODE_BROWSER_SEMANTIC_DIR) }),
    check("schema-budget", Buffer.byteLength(JSON.stringify(tools)) < 8000, { bytes: Buffer.byteLength(JSON.stringify(tools)), maxBytes: 8000 }),
    check("stale-client-paths", !fs.existsSync(path.join(info.root, ["opencode", "plugin"].join("-"))) && !fs.existsSync(path.join(info.root, ["codex", "adapter"].join("-"))), {}),
  ];
  const skillSource = skillSourceDirectory();
  const canonicalHash = fs.existsSync(path.join(skillSource, "SKILL.md")) ? directoryHash(skillSource) : null;
  const skillTargetsList = skillTargets();
  checks.push(
    check("skill-source", Boolean(canonicalHash), { path: "skills/opencode-browser-plugin" }),
    check("skill-installed", Boolean(canonicalHash) && skillTargetsList.every((target) => fs.existsSync(path.join(target, "SKILL.md"))), { locations: skillTargetsList }),
    check("skill-parity", Boolean(canonicalHash) && skillTargetsList.every((target) => fs.existsSync(path.join(target, "SKILL.md")) && directoryHash(target).sha256 === canonicalHash.sha256), {}),
    check("skill-codex-config", (() => {
      const config = codexConfigPath();
      if (!fs.existsSync(config)) return false;
      const text = fs.readFileSync(config, "utf8");
      return /\[\[skills\.config\]\]/.test(text) && /path\s*=.*opencode-browser-plugin.*SKILL\.md/s.test(text) && /enabled\s*=\s*true/.test(text);
    })(), { path: codexConfigPath() }),
    check("skill-stale-entry", (() => {
      const config = codexConfigPath();
      if (!fs.existsSync(config)) return true;
      return !fs.readFileSync(config, "utf8").includes(STALE_SKILL_MARKER);
    })(), {}),
  );
  const report = { ok: checks.every((item) => item.ok), ...info, checks, generatedAt: new Date().toISOString() };
  if (json) return report;
  return report;
}
