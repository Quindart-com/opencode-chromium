import { createCoreRegistry,createMemoryRegistry } from "../../core/registry.ts";
import type { RuntimeOptions } from "../../core/runtime-types.ts";
import type { AgentBrowserRuntime } from "../../core/runtime.ts";
import { createAgentBrowserRuntime } from "../../core/runtime.ts";
import { dispatchBrowserTool,toolDefinitionsForDialect } from "../../core/schema-adapters.ts";
import type { BrowserContext } from "../../core/tool-definition.ts";

export function createBrowserAgent(options: RuntimeOptions & { runtime?: AgentBrowserRuntime; memory?: boolean } = {}) {
  const runtime = options.runtime ?? createAgentBrowserRuntime(options);
  const registry = { ...createCoreRegistry(runtime), ...(options.memory ? createMemoryRegistry(runtime) : {}) };
  return {
    runtime,
    registry,
    tools(dialect = "openai") {
      return toolDefinitionsForDialect(registry, dialect);
    },
    call(name: string, args: unknown, context?: BrowserContext) {
      return dispatchBrowserTool(registry, name, args, context);
    },
    close() {
      runtime.close();
    },
  };
}

export { anthropicTools } from "./anthropic.ts";
export { geminiTools } from "./gemini.ts";
export { mcpTools } from "./mcp.ts";
export { openAITools } from "./openai.ts";
