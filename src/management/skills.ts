import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessId } from "./configuration.js";
import type { FileChange } from "./transaction.js";

/** Skill changes join the configuration transaction, including dry runs. */
export function planSkills(root: string, targets: HarnessId[], remove = false, home = os.homedir()): FileChange[] {
  const directories = new Set<string>();
  for (const target of targets) {
    if (target === "codex") directories.add(path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "skills"));
    if (target === "claude-code") directories.add(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "skills"));
    if (target.startsWith("opencode")) directories.add(path.join(home, ".agents", "skills"));
  }
  const source = path.join(root, "skills", "opencode-browser-plugin");
  const files = ["SKILL.md", "agents/openai.yaml"];
  return [...directories].flatMap(directory => files.map(relative => {
    const filePath = path.join(directory, "opencode-browser-plugin", relative);
    const before = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
    return { filePath, before, after: remove ? null : fs.readFileSync(path.join(source, relative), "utf8") };
  }));
}
