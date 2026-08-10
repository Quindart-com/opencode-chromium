import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenCodeSetup } from "../adapters/opencode/index.js";
import { createBrowserAgent } from "../adapters/sdk/index.js";
import { directoryHash, skillSourceDirectory, skillTargets } from "./skills.js";

export async function verify() {
  const agent = createBrowserAgent();
  try {
    const tools = agent.tools("mcp");
    if (tools.length !== 4) throw new Error(`Expected four tools, found ${tools.length}`);
    const cleanup = await createOpenCodeSetup({ logger: { info() {} } });
    await cleanup();
    const canonical = directoryHash(skillSourceDirectory());
    const skills = skillTargets(os.homedir()).map((target) => {
      const installed = fs.existsSync(path.join(target, "SKILL.md"));
      const parity = installed ? directoryHash(target).sha256 === canonical.sha256 : false;
      return { path: target, installed, parity };
    });
    const skillsOk = skills.every((skill) => skill.installed && skill.parity);
    return { ok: skillsOk, tools: tools.map((tool) => tool.name), verified: ["core", "sdk", "opencode", "skills"], skills };
  } finally {
    agent.close();
  }
}