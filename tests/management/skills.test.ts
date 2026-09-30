import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planSkills } from "../../src/management/skills.ts";
import { applyTransaction } from "../../src/management/transaction.ts";

test("selected-client skill dry run preserves an existing skill and never installs other clients", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-skills-test-"));
  try {
    const file = path.join(home, ".agents/skills/opencode-browser-plugin/SKILL.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "previous skill");
    const changes = planSkills(process.cwd(), ["opencode"], false, home);
    applyTransaction(changes, true);
    expect(fs.readFileSync(file, "utf8")).toBe("previous skill");
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
    applyTransaction(changes);
    expect(fs.readFileSync(file, "utf8")).toContain("opencode");
    expect(applyTransaction(planSkills(process.cwd(), ["opencode"], false, home)).changedFiles).toEqual([]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
