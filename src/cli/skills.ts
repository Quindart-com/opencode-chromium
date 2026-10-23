import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { nativeCodexPluginEnabled } from "../management/configuration.ts";
import type { Harness } from "../management/harnesses.ts";
import { detectHarnesses } from "../management/harnesses.ts";
import { skillDirectories } from "../management/skills.ts";
import { record } from "../shared/values.ts";
import { backup,packageRoot } from "./config.ts";

export const SKILL_NAME = "opencode-browser-plugin";
export const SKILL_CONFIG_MARKER = SKILL_NAME;
// Legacy project-scoped skill from an earlier release; the .opencode/skills
// source no longer ships, so install/uninstall clean up any leftover enable.
export const STALE_SKILL_MARKER = "opencode-browser-adapter";

function home() {
  return os.homedir();
}

// An explicit `homedir` override (tests) bypasses CODEX_HOME so callers get a
// fully isolated root. With no override, the real Codex home wins.
function codexHomeDir(homedir?: string) {
  return homedir === undefined ? process.env.CODEX_HOME ?? path.join(home(), ".codex") : path.join(homedir, ".codex");
}

export function skillSourceDirectory() {
  return path.join(packageRoot(), "skills", SKILL_NAME);
}

export function skillTargets(homedir?: string) {
  const root = homedir ?? home();
  return [
    path.join(codexHomeDir(homedir), "skills", SKILL_NAME),
    path.join(root, ".claude", "skills", SKILL_NAME),
    path.join(root, ".agents", "skills", SKILL_NAME),
  ];
}

export function codexConfigPath(homedir?: string) {
  return path.join(codexHomeDir(homedir), "config.toml");
}

export function directoryHash(directory: string) {
  const files: string[] = [];
  function walk(current: string) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push(path.relative(directory, absolute).replaceAll(path.sep, "/"));
    }
  }
  walk(directory);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(directory, file)));
  }
  return { files: files.length, sha256: hash.digest("hex") };
}

/** Health follows configured clients; a targeted install need not copy every skill home. */
export function inspectHarnessSkills({ harnesses = detectHarnesses(), homedir, source = skillSourceDirectory() }: { harnesses?: Harness[]; homedir?: string; source?: string } = {}) {
  const configured = harnesses.filter(row => row.managed && row.supported);
  const nativePlugins = configured.filter(row => row.id === "codex" && nativeCodexPluginEnabled(fs.readFileSync(row.configPath, "utf8"))).map(row => row.id);
  const directories = skillDirectories(configured.filter(row => !nativePlugins.includes(row.id)).map(row => row.id), homedir);
  const canonical = fs.existsSync(path.join(source, "SKILL.md")) ? directoryHash(source).sha256 : null;
  const skills = directories.map(directory => {
    const target = path.join(directory, SKILL_NAME);
    const installed = fs.existsSync(path.join(target, "SKILL.md"));
    return { path: target, installed, parity: installed && Boolean(canonical) && directoryHash(target).sha256 === canonical };
  });
  const codex = configured.find(row => row.id === "codex");
  const codexSettings = codex ? record(parseToml(fs.readFileSync(codex.configPath, "utf8")).skills).config ?? [] : [];
  const codexEnabled = !codex || nativePlugins.includes("codex") || !Array.isArray(codexSettings) ||
    !codexSettings.some(value => { const entry = record(value); return entry.enabled === false && typeof entry.path === "string" && entry.path.includes(SKILL_NAME); });
  return { source: Boolean(canonical), clients: configured.map(row => row.id), nativePlugins, skills, codexEnabled };
}

function removeSkillsConfigBlocks(text: string, marker: string) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "[[skills.config]]") {
      const block = [line];
      let drop = false;
      i += 1;
      while (i < lines.length && !/^\[\[?/.test(lines[i] ?? "")) {
        const item = lines[i] ?? "";
        block.push(item);
        if (/^\s*path\s*=/.test(item) && item.includes(marker)) drop = true;
        i += 1;
      }
      if (!drop) out.push(...block);
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + (text.endsWith("\n") ? "\n" : "");
}

function codexSkillBlock(skillMetadataPath: string) {
  const resolvedPath = /^[A-Za-z]:[\\/]/.test(skillMetadataPath)
    ? path.win32.resolve(skillMetadataPath)
    : path.resolve(skillMetadataPath);
  return `[[skills.config]]
path = ${JSON.stringify(resolvedPath)}
enabled = true`;
}

export function upsertCodexSkillConfig(text: string, skillMetadataPath: string) {
  const block = codexSkillBlock(skillMetadataPath);
  // Leave an already-correct block where it is: re-appending it on every run
  // moved it past the MCP section and rewrote the user's config each time.
  const withoutStale = removeSkillsConfigBlocks(text, STALE_SKILL_MARKER);
  if (withoutStale !== text || !text.includes(block)) {
    const cleaned = removeSkillsConfigBlocks(withoutStale, SKILL_CONFIG_MARKER);
    return `${cleaned.trimEnd()}${cleaned.trim() ? "\n\n" : ""}${block}\n`;
  }
  return text;
}

export function cleanCodexSkillConfig(text: string) {
  return removeSkillsConfigBlocks(removeSkillsConfigBlocks(text, SKILL_CONFIG_MARKER), STALE_SKILL_MARKER);
}

function copySkills(source: string, target: string, dryRun: boolean) {
  if (dryRun) return;
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
}

export function installSkills({ dryRun = false, homedir }: { dryRun?: boolean; homedir?: string } = {}) {
  const source = skillSourceDirectory();
  if (!fs.existsSync(path.join(source, "SKILL.md"))) throw new Error(`Skill source is missing: ${source}`);
  const canonical = directoryHash(source);
  const changedFiles = [];
  const backups = [];
  for (const target of skillTargets(homedir)) {
    const installed = fs.existsSync(path.join(target, "SKILL.md"));
    const parity = installed ? directoryHash(target).sha256 === canonical.sha256 : false;
    if (!installed || !parity) {
      copySkills(source, target, dryRun);
      changedFiles.push(target);
    }
  }
  const codexConfig = codexConfigPath(homedir);
  const codexSkillFile = path.join(codexHomeDir(homedir), "skills", SKILL_NAME, "SKILL.md");
  const before = fs.existsSync(codexConfig) ? fs.readFileSync(codexConfig, "utf8") : "";
  const after = upsertCodexSkillConfig(before, codexSkillFile);
  if (after !== before) {
    if (!dryRun) {
      fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
      const backupPath = backup(codexConfig);
      if (backupPath) backups.push(backupPath);
      fs.writeFileSync(codexConfig, after, "utf8");
    }
    changedFiles.push(codexConfig);
  }
  return { client: "skills", action: "install", changed: changedFiles.length > 0, changedFiles, backups, dryRun };
}

export function uninstallSkills({ dryRun = false, homedir }: { dryRun?: boolean; homedir?: string } = {}) {
  const changedFiles = [];
  for (const target of skillTargets(homedir)) {
    if (fs.existsSync(target)) {
      if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
      changedFiles.push(target);
    }
  }
  const codexConfig = codexConfigPath(homedir);
  if (fs.existsSync(codexConfig)) {
    const before = fs.readFileSync(codexConfig, "utf8");
    const after = cleanCodexSkillConfig(before);
    if (after !== before) {
      if (!dryRun) {
        const backupPath = backup(codexConfig);
        if (backupPath) changedFiles.push(backupPath);
        fs.writeFileSync(codexConfig, after, "utf8");
      }
      changedFiles.push(codexConfig);
    }
  }
  return { client: "skills", action: "uninstall", changed: changedFiles.length > 0, changedFiles, dryRun };
}
