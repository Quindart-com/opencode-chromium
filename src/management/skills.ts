import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessId } from "./configuration.js";
import type { FileChange } from "./transaction.js";

export function skillDirectories(targets: HarnessId[], home?: string): string[] {
  const targetHome = home ?? os.homedir();
  const directories = new Set<string>();
  for (const target of targets) {
    if (target === "codex") directories.add(path.join(home === undefined ? process.env.CODEX_HOME ?? path.join(targetHome, ".codex") : path.join(targetHome, ".codex"), "skills"));
    if (target === "claude-code") directories.add(path.join(home === undefined ? process.env.CLAUDE_CONFIG_DIR ?? path.join(targetHome, ".claude") : path.join(targetHome, ".claude"), "skills"));
    if (target.startsWith("opencode")) directories.add(path.join(targetHome, ".agents", "skills"));
  }
  return [...directories];
}

/** Skill changes join the configuration transaction, including dry runs. */
export function planSkills(root: string, targets: HarnessId[], remove = false, home?: string): FileChange[] {
  const source = path.join(root, "skills", "opencode-browser-plugin");
  const files = ["SKILL.md", "agents/openai.yaml"];
  return skillDirectories(targets, home).flatMap(directory => files.map(relative => {
    const filePath = path.join(directory, "opencode-browser-plugin", relative);
    const before = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
    return { filePath, before, after: remove ? null : fs.readFileSync(path.join(source, relative), "utf8") };
  }));
}
