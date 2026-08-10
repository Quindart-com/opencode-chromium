import { createAgentBrowserRuntime } from "../../core/runtime.js";
import { createCoreRegistry } from "../../core/registry.js";
import { dispatchBrowserTool, toolDefinitionsForDialect } from "../../core/schema-adapters.js";

export function createBrowserAgent(options = {}) {
  const runtime = options.runtime ?? createAgentBrowserRuntime(options);
  const registry = createCoreRegistry(runtime);
  return {
    runtime,
    registry,
    tools(dialect = "openai") {
      return toolDefinitionsForDialect(registry, dialect);
    },
    call(name, args, context) {
      return dispatchBrowserTool(registry, name, args, context);
    },
    close() {
      runtime.close();
    },
  };
}

export { openAITools } from "./openai.js";
export { anthropicTools } from "./anthropic.js";
export { geminiTools } from "./gemini.js";
export { mcpTools } from "./mcp.js";
