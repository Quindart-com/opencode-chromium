import { createOpenCodeSetup } from "../adapters/opencode/index.ts";
import { createBrowserAgent } from "../adapters/sdk/index.ts";
import { inspectHarnessSkills } from "./skills.ts";

export async function verify() {
  const agent = createBrowserAgent();
  try {
    const tools = agent.tools("mcp").map(tool => tool.name);
    if (tools.length !== 4) throw new Error(`Expected four tools, found ${tools.length}`);
    const registered = new Set<string>();
    const cleanup = await createOpenCodeSetup({ tool: { transform(register) {
      register({ add: tool => registered.add(tool.name) });
    } }, logger: { info() {} } }, { memory: false });
    try {
      if (registered.size !== tools.length || tools.some(name => !registered.has(name))) {
        throw new Error("The OpenCode adapter did not register the four browser tools");
      }
    } finally { await cleanup(); }
    const skillHealth = inspectHarnessSkills();
    const skillsOk = skillHealth.source && skillHealth.clients.length > 0 && skillHealth.codexEnabled && skillHealth.skills.every(skill => skill.installed && skill.parity);
    return { ok: skillsOk, tools, verified: ["core", "sdk", "opencode", "skills"], ...skillHealth };
  } finally {
    agent.close();
  }
}
