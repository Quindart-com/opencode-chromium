import { createOpenCodeSetup } from "../adapters/opencode/index.js";
import { createBrowserAgent } from "../adapters/sdk/index.js";
import { inspectHarnessSkills } from "./skills.js";

export async function verify() {
  const agent = createBrowserAgent();
  try {
    const tools = agent.tools("mcp");
    if (tools.length !== 4) throw new Error(`Expected four tools, found ${tools.length}`);
    const cleanup = await createOpenCodeSetup({ logger: { info() {} } });
    await cleanup();
    const skillHealth = inspectHarnessSkills();
    const skillsOk = skillHealth.source && skillHealth.clients.length > 0 && skillHealth.codexEnabled && skillHealth.skills.every(skill => skill.installed && skill.parity);
    return { ok: skillsOk, tools: tools.map((tool) => tool.name), verified: ["core", "sdk", "opencode", "skills"], ...skillHealth };
  } finally {
    agent.close();
  }
}
