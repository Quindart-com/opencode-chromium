import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserAgent } from "../../src/adapters/sdk/index.js";
import { openAITools } from "../../src/adapters/sdk/openai.js";
import { anthropicTools } from "../../src/adapters/sdk/anthropic.js";
import { geminiTools } from "../../src/adapters/sdk/gemini.js";
import { mcpTools } from "../../src/adapters/sdk/mcp.js";
import plugin, { createOpenCodeSetup } from "../../src/adapters/opencode/index.js";
import { SERVER_NAME, SERVER_INSTRUCTIONS, parseArgs } from "../../src/adapters/mcp/server.js";

test("all schema adapters expose exactly the four canonical tools", () => {
  const agent = createBrowserAgent();
  try {
    for (const tools of [agent.tools("mcp"), agent.tools("openai"), agent.tools("anthropic"), agent.tools("gemini")]) {
      assert.deepEqual(tools.map((tool) => tool.name), ["browser_run", "browser_observe", "browser_session", "browser_finalize"]);
    }
    assert.equal(openAITools({ runtime: agent.runtime }).length, 4);
    assert.equal(anthropicTools({ runtime: agent.runtime }).length, 4);
    assert.equal(geminiTools({ runtime: agent.runtime }).length, 4);
    assert.equal(mcpTools({ runtime: agent.runtime }).length, 4);
  } finally {
    agent.close();
  }
});

test("native OpenCode setup is repeatable and does not use a registration guard", async () => {
  const registered = [];
  const context = { tools: { add: async (name, definition) => registered.push({ name, definition }) }, logger: { info() {} } };
  const first = await createOpenCodeSetup(context);
  await first();
  const second = await createOpenCodeSetup(context);
  try {
    assert.equal(plugin.id, "opencode-browser-plugin");
    assert.equal(registered.length, 8);
    assert.ok(registered.every(({ definition }) => definition.codemode === false));
  } finally {
    await second();
  }
});

test("native OpenCode 1.18 module loading exposes the four core tools", async () => {
  assert.equal(typeof plugin, "object");
  assert.equal(typeof plugin.server, "function");
  const hooks = await plugin.server({});
  try {
    assert.equal(plugin.id, "opencode-browser-plugin");
    assert.deepEqual(Object.keys(hooks.tool ?? {}), ["browser_run", "browser_observe", "browser_session", "browser_finalize"]);
  } finally {
    await hooks.dispose();
  }
});

test("MCP options and instructions are provider-neutral", () => {
  assert.equal(SERVER_NAME, "opencode-browser-plugin");
  assert.match(SERVER_INSTRUCTIONS, /browser_run/);
  assert.deepEqual(parseArgs(["--transport=http", "--toolset", "debug", "--port=4321"]), { transport: "http", toolset: "debug", host: "127.0.0.1", port: 4321, authTokenEnv: "AGENT_BROWSER_AUTH_TOKEN" });
});
