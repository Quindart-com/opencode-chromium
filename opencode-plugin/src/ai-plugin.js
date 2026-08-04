import { createAgentBrowserRuntime } from "../../browser-core/runtime.js";
import { createCoreRegistry } from "../../browser-core/registry.js";

let sharedRuntime;

function runtime() {
  sharedRuntime ??= createAgentBrowserRuntime();
  return sharedRuntime;
}

export const AgentChromiumBrowserPlugin = async () => {
  const registry = createCoreRegistry(runtime());
  return {
    tool: Object.fromEntries(Object.entries(registry).map(([name, definition]) => [name, {
      description: definition.description,
      args: definition.inputSchema.shape,
      async execute(args, context) {
        return JSON.stringify(await definition.execute(args, context));
      },
    }])),
  };
};
