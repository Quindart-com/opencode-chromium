import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { backup, packageRoot } from "./config.js";

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
function codexHomeDir(homedir) {
  return homedir === undefined ? process.env.CODEX_HOME ?? path.join(home(), ".codex") : path.join(homedir, ".codex");
}

export function skillSourceDirectory() {
  return path.join(packageRoot(), "skills", SKILL_NAME);
}

export function skillTargets(homedir) {
  const root = homedir ?? home();
  return [
    path.join(codexHomeDir(homedir), "skills", SKILL_NAME),
    path.join(root, ".claude", "skills", SKILL_NAME),
    path.join(root, ".agents", "skills", SKILL_NAME),
  ];
}

export function codexConfigPath(homedir) {
  return path.join(codexHomeDir(homedir), "config.toml");
}

export function directoryHash(directory) {
  const files = [];
  function walk(current) {
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

function removeSkillsConfigBlocks(text, marker) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "[[skills.config]]") {
      const block = [line];
      let drop = false;
      i += 1;
      while (i < lines.length && !/^\[\[?/.test(lines[i])) {
        block.push(lines[i]);
        if (/^\s*path\s*=/.test(lines[i]) && lines[i].includes(marker)) drop = true;
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

function codexSkillBlock(skillMetadataPath) {
  return `[[skills.config]]
path = ${JSON.stringify(path.resolve(skillMetadataPath))}
enabled = true`;
}

export function upsertCodexSkillConfig(text, skillMetadataPath) {
  let after = removeSkillsConfigBlocks(text, STALE_SKILL_MARKER);
  after = removeSkillsConfigBlocks(after, SKILL_CONFIG_MARKER);
  const block = codexSkillBlock(skillMetadataPath);
  return `${after.trimEnd()}${after.trim() ? "\n\n" : ""}${block}\n`;
}

export function cleanCodexSkillConfig(text) {
  return removeSkillsConfigBlocks(removeSkillsConfigBlocks(text, SKILL_CONFIG_MARKER), STALE_SKILL_MARKER);
}

function copySkills(source, target, dryRun) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  if (!dryRun) fs.cpSync(source, target, { recursive: true });
}

export function installSkills({ dryRun = false, homedir } = {}) {
  const root = homedir ?? home();
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

export function uninstallSkills({ dryRun = false, homedir } = {}) {
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