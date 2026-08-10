import { tool as openCodeTool } from "@opencode-ai/plugin";
import { define } from "@opencode-ai/plugin/v2/promise";
import { createAgentBrowserRuntime } from "../../core/runtime.js";
import { createCoreRegistry } from "../../core/registry.js";
import { dispatchBrowserTool, jsonSchemaFor } from "../../core/schema-adapters.js";
import { contractMetadata, PLUGIN_NAME, PLUGIN_VERSION } from "../../core/versions.js";
import { createLogger } from "../../core/logging.js";

function concise(result) {
  const text = JSON.stringify(result);
  if (text.length <= 4096) return text;
  return JSON.stringify({
    ok: result.ok,
    status: result.status,
    sessionId: result.sessionId,
    summary: result.summary ?? "The complete result is available through the artifact URI.",
    artifact: result.artifact,
  });
}

function nativeTool(name, definition, runtime) {
  const inputSchema = jsonSchemaFor(definition.inputSchema);
  return {
    id: name,
    name,
    description: definition.description,
    inputSchema,
    parameters: inputSchema,
    outputSchema: jsonSchemaFor(definition.outputSchema),
    annotations: definition.annotations,
    codemode: false,
    async execute(args, context = {}) {
      const result = await dispatchBrowserTool({ [name]: definition }, name, args, {
        ...context,
        agent: "opencode-v2",
      });
      return {
        output: concise(result),
        content: [{ type: "text", text: concise(result) }],
        structuredContent: result,
        ...contractMetadata(),
      };
    },
  };
}

function legacyTool(name, definition, runtime) {
  return openCodeTool({
    description: definition.description,
    args: definition.inputSchema.shape,
    async execute(args, context = {}) {
      const result = await dispatchBrowserTool({ [name]: definition }, name, args, {
        ...context,
        agent: "opencode",
      });
      return {
        title: result.summary ?? `Completed ${name}`,
        output: concise(result),
        metadata: { ...contractMetadata(), tool: name, sessionId: result.sessionId ?? null },
      };
    },
  });
}

function createLegacyOpenCodeHooks(options = {}) {
  const runtime = options.runtime ?? createAgentBrowserRuntime(options);
  const registry = createCoreRegistry(runtime);
  const tools = Object.fromEntries(Object.entries(registry).map(([name, definition]) => [name, legacyTool(name, definition, runtime)]));
  let disposed = false;
  return {
    tool: tools,
    async dispose() {
      if (disposed) return;
      disposed = true;
      runtime.close();
    },
    runtime,
    registry,
  };
}

async function registerWithContext(ctx, name, tool) {
  if (typeof ctx?.tools?.add === "function") return ctx.tools.add(name, tool);
  if (typeof ctx?.tool?.add === "function") return ctx.tool.add(name, tool);
  if (typeof ctx?.addTool === "function") return ctx.addTool(name, tool);
  if (typeof ctx?.tool?.transform === "function") {
    return ctx.tool.transform({ name, tool, codemode: false });
  }
  return undefined;
}

export async function createOpenCodeSetup(ctx = {}, options = {}) {
  const runtime = options.runtime ?? ctx.runtime ?? createAgentBrowserRuntime(options);
  const registry = createCoreRegistry(runtime);
  const tools = Object.fromEntries(Object.entries(registry).map(([name, definition]) => [name, nativeTool(name, definition, runtime)]));
  const logger = options.logger ?? ctx.logger ?? createLogger({ name: PLUGIN_NAME, sink: process.stderr });
  for (const [name, tool] of Object.entries(tools)) {
    await registerWithContext(ctx, name, tool);
  }
  logger.info("OpenCode V2 browser tools registered", { plugin: PLUGIN_NAME, tools: Object.keys(tools) });

  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    runtime.close();
    logger.info("OpenCode V2 browser tools cleaned up", { plugin: PLUGIN_NAME });
  };
  cleanup.tools = tools;
  cleanup.registry = registry;
  cleanup.runtime = runtime;
  cleanup.dispose = cleanup;
  return cleanup;
}

const opencodeV2Plugin = define({
  id: PLUGIN_NAME,
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  async setup(ctx, options) {
    return createOpenCodeSetup(ctx, options);
  },
  metadata: contractMetadata(),
});

async function opencodeBrowserPluginEntry(ctx = {}, options = {}) {
  if (ctx?.tools?.add || ctx?.tool?.add || ctx?.addTool || ctx?.tool?.transform) {
    return createOpenCodeSetup(ctx, options);
  }
  return createLegacyOpenCodeHooks(options);
}

Object.assign(opencodeBrowserPluginEntry, {
  id: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  setup: opencodeV2Plugin.setup,
  metadata: contractMetadata(),
  v2: opencodeV2Plugin,
});
Object.defineProperty(opencodeBrowserPluginEntry, "name", { value: PLUGIN_NAME, configurable: true });

export const opencodeBrowserPlugin = opencodeBrowserPluginEntry;
export const opencodePluginModule = Object.freeze({
  id: PLUGIN_NAME,
  server: opencodeBrowserPluginEntry,
});
export { opencodeV2Plugin };
export default opencodePluginModule;
