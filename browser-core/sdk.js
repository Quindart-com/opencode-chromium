import { createAgentBrowserRuntime } from "./runtime.js";
import { createCoreRegistry } from "./registry.js";
import { dispatchBrowserTool, toolDefinitionsForDialect } from "./schema-adapters.js";

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
