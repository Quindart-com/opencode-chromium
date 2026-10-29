import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProfileRegistrations } from "../../native-host/src/profile-registry.ts";
import { participants,participantBusy,processAlive,reapParticipants } from "../../native-host/src/runtime-participants.ts";
import { createBrowserAgent } from "../adapters/sdk/index.ts";
import { errorMessage } from "../core/errors.ts";
import { firefoxHealth } from "./firefox.ts";
import { codexConfigPath,inspectHarnessSkills,STALE_SKILL_MARKER } from "./skills.ts";
import { packageInfo } from "./version.ts";
import { runtimeDir } from "./native-host.ts";
import { inspectProjectBrowserPlugin } from "./codex-marketplace.ts";
import { connectionDoctor } from "./connection-doctor.ts";

const MAX_SCHEMA_BYTES = 13000;

function check(name: string, ok: unknown, details: Record<string, unknown> = {}) {
  return { name, ok: Boolean(ok), ...details };
}

export async function runDoctor({ json = false, repairRuntime = false } = {}) {
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
    check("runtime", Boolean(process.versions.bun) || Number.parseInt(process.versions.node, 10) >= 20, { bun: process.versions.bun ?? null, node: process.versions.node }),
    check("package", info.name === "opencode-chromium" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(info.version ?? ""), { name: info.name, version: info.version }),
    check("build", fs.existsSync(path.join(dist, "build-manifest.json")), { path: "dist" }),
    check("four-tools", tools.length === 4, { tools: tools.map((tool) => tool.name) }),
    check("artifact-directory", (() => { try { fs.mkdirSync(artifactDir, { recursive: true }); return fs.statSync(artifactDir).isDirectory(); } catch { return false; } })(), { configured: Boolean(process.env.AGENT_BROWSER_ARTIFACT_DIR ?? process.env.OPENCODE_BROWSER_ARTIFACT_DIR) }),
    check("extension", fs.existsSync(path.join(info.root, "extension", "manifest.json")), { installed: false, message: "Use check:extension for browser-profile discovery." }),
    check("native-host", fs.existsSync(path.join(info.root, "native-host", "dist", "runtime.js")), { installed: false, message: "Use install:native-host to register the host." }),
    check("semantic-cache", true, { configured: Boolean(process.env.AGENT_BROWSER_SEMANTIC_DIR ?? process.env.OPENCODE_BROWSER_SEMANTIC_DIR) }),
    check("qwen-cache", true, { configured: Boolean(process.env.AGENT_BROWSER_SEMANTIC_DIR ?? process.env.OPENCODE_BROWSER_SEMANTIC_DIR) }),
    check("schema-budget", Buffer.byteLength(JSON.stringify(tools)) < MAX_SCHEMA_BYTES, { bytes: Buffer.byteLength(JSON.stringify(tools)), maxBytes: MAX_SCHEMA_BYTES }),
    check("stale-client-paths", !fs.existsSync(path.join(info.root, ["opencode", "plugin"].join("-"))) && !fs.existsSync(path.join(info.root, ["codex", "adapter"].join("-"))), {}),
  ];
  for (const profile of readProfileRegistrations().filter(item => /Firefox|LibreWolf/i.test(item.browserName ?? ""))) {
    try {
      const health = await firefoxHealth(profile.profileId);
      checks.push(check("firefox-remote-agent", health.configured && health.reachable, health));
    } catch (error) { checks.push(check("firefox-remote-agent", false, { profileId: profile.profileId, message: errorMessage(error) })); }
  }
  const skillHealth = inspectHarnessSkills();
  const projectPlugin = inspectProjectBrowserPlugin(info.version);
  if (projectPlugin) checks.push(check("codex-project-marketplace", projectPlugin.ok, projectPlugin));
  try {
    const before = participants(runtimeDir());
    if (repairRuntime) reapParticipants(runtimeDir());
    const rows = repairRuntime ? participants(runtimeDir()) : before;
    const staleIdle = rows.filter(row => !processAlive(row.pid) && !participantBusy(row)).length;
    checks.push(check("runtime-participants", staleIdle === 0, { count: rows.length, staleIdle,
      removed: before.length - rows.length, repairCommand: "opencode-chromium doctor --repair-runtime --json",
      message: "Repair removes only dead, idle process records. Sessions and approvals are retained." }));
  } catch { checks.push(check("runtime-participants", false, { message: "Runtime process metadata could not be read. Preserve it and inspect locally before repairing." })); }
  const skillInstallCommand = skillHealth.clients.length ? "opencode-chromium setup --targets " + skillHealth.clients.join(",") : "opencode-chromium setup --all";
  const staleSkillTargets = skillHealth.skills.filter(skill => !skill.parity).map(skill => skill.path);
  checks.push(
    check("client-configuration", skillHealth.clients.length > 0, { clients: skillHealth.clients, installCommand: skillInstallCommand }),
    check("skill-source", skillHealth.source, { path: "skills/opencode-browser-plugin" }),
    check("skill-installed", skillHealth.source && skillHealth.skills.every(skill => skill.installed), { locations: skillHealth.skills.map(skill => skill.path), nativePlugins: skillHealth.nativePlugins, installCommand: skillInstallCommand }),
    check("skill-parity", staleSkillTargets.length === 0, { stale: staleSkillTargets, installCommand: skillInstallCommand }),
    check("skill-codex-config", skillHealth.codexEnabled, { path: codexConfigPath(), installCommand: skillInstallCommand }),
    check("skill-stale-entry", (() => {
      const config = codexConfigPath();
      if (!fs.existsSync(config)) return true;
      return !fs.readFileSync(config, "utf8").includes(STALE_SKILL_MARKER);
    })(), {}),
  );
  const connection = await connectionDoctor();
  checks.push(...connection.checks);
  const report = { ok: checks.every((item) => item.ok), ...info, checks, generatedAt: new Date().toISOString() };
  if (json) return report;
  return report;
}
