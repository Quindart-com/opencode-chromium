import { tool as openCodeTool } from "@opencode-ai/plugin";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { createLogger } from "../../core/logging.ts";
import { createCoreRegistry,createMemoryRegistry } from "../../core/registry.ts";
import type { RuntimeOptions } from "../../core/runtime-types.ts";
import type { AgentBrowserRuntime } from "../../core/runtime.ts";
import { createAgentBrowserRuntime } from "../../core/runtime.ts";
import { dispatchBrowserTool,jsonSchemaFor } from "../../core/schema-adapters.ts";
import type { BrowserContext,RuntimeTool } from "../../core/tool-definition.ts";
import { responseMetadata as contractMetadata,PLUGIN_NAME,PLUGIN_VERSION } from "../../core/versions.ts";
import { memoryEnabledForServer } from "../../memory/index.ts";
import { record } from "../../shared/values.ts";
import { imageCandidates,sanitizeImages } from "../image-content.ts";



const IMAGE_EXTENSION_BY_MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
type OpenCodeOptions = RuntimeOptions & { runtime?: AgentBrowserRuntime; memory?: boolean };
type NativeTool = ReturnType<typeof nativeTool>;
interface OpenCodeContext { runtime?: AgentBrowserRuntime; logger?: Pick<ReturnType<typeof createLogger>, "info">;
  tools?: { add?(name: string, tool: NativeTool): unknown | Promise<unknown> };
  tool?: { add?(name: string, tool: NativeTool): unknown | Promise<unknown>; transform?(input: { name: string; tool: NativeTool; codemode: boolean }): unknown | Promise<unknown> };
  addTool?(name: string, tool: NativeTool): unknown | Promise<unknown>;
}
const IMAGE_ATTACHMENT_LIMIT = 4;





function toAttachment(mimeType: string, data: Uint8Array) {
  if (!data) return null;
  const extension = IMAGE_EXTENSION_BY_MIME[mimeType] ?? "png";
  return {
    type: "file" as const,
    mime: mimeType,
    filename: `screenshot.${extension}`,
    url: `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`,
  };
}

function imageAttachments(result: unknown, runtime: Pick<AgentBrowserRuntime, "artifacts">) {
  try {
    const attachments = [];
    for (const candidate of imageCandidates(result)) {
      if (attachments.length >= IMAGE_ATTACHMENT_LIMIT) break;
      if (typeof candidate.base64 === "string") {
        const attachment = toAttachment(candidate.mimeType, Buffer.from(candidate.base64, "base64"));
        if (attachment) attachments.push(attachment);
      } else if (runtime?.artifacts) {
        const artifact = runtime.artifacts.read(candidate.artifactId ?? candidate.uri ?? "");
        const attachment = artifact?.data ? toAttachment(candidate.mimeType, artifact.data) : null;
        if (attachment) attachments.push(attachment);
      }
    }
    return attachments.length > 0 ? attachments : undefined;
  } catch {
    // Attachments are an enhancement; never fail the tool result for them.
  }
  return undefined;
}

function sanitizeImagePayloads(value: unknown): unknown { return sanitizeImages(value, "attachment"); }

function concise(result: unknown) {
  const text = JSON.stringify(sanitizeImagePayloads(result)) ?? "null";
  if (text.length <= 4096) return text;
  return JSON.stringify({
    ok: record(result).ok,
    status: record(result).status,
    sessionId: record(result).sessionId,
    summary: record(result).summary ?? "The complete result is available through the artifact URI.",
    artifact: record(result).artifact,
  });
}

function nativeTool(name: string, definition: RuntimeTool, runtime: AgentBrowserRuntime) {
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
    async execute(args: unknown, context: BrowserContext = {}) {
      const result = await dispatchBrowserTool({ [name]: definition }, name, args, {
        ...context,
        agent: "opencode-v2",
      });
      const output = concise(result);
      return {
        output,
        content: [{ type: "text", text: output }],
        structuredContent: sanitizeImagePayloads(result),
        attachments: imageAttachments(result, runtime),
        ...contractMetadata(),
      };
    },
  };
}

function legacyTool(name: string, definition: RuntimeTool, runtime: AgentBrowserRuntime) {
  return openCodeTool({
    description: definition.description,
    args: definition.inputSchema instanceof z.ZodObject ? definition.inputSchema.shape : {},
    async execute(args, context) {
      const result = await dispatchBrowserTool({ [name]: definition }, name, args, {
        ...context,
        agent: "opencode",
      });
      return {
        title: typeof record(result).summary === "string" ? String(record(result).summary) : `Completed ${name}`,
        output: concise(result),
        attachments: imageAttachments(result, runtime),
        metadata: { ...contractMetadata(), tool: name, sessionId: record(result).sessionId ?? null },
      };
    },
  });
}

function createLegacyOpenCodeHooks(options: OpenCodeOptions = {}) {
  const runtime = options.runtime ?? createAgentBrowserRuntime(options);
  const registry = { ...createCoreRegistry(runtime), ...(options.memory ?? memoryEnabledForServer() ? createMemoryRegistry(runtime) : {}) };
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

async function registerWithContext(ctx: OpenCodeContext, name: string, tool: NativeTool) {
  if (typeof ctx?.tools?.add === "function") return ctx.tools.add(name, tool);
  if (typeof ctx?.tool?.add === "function") return ctx.tool.add(name, tool);
  if (typeof ctx?.addTool === "function") return ctx.addTool(name, tool);
  if (typeof ctx?.tool?.transform === "function") {
    return ctx.tool.transform({ name, tool, codemode: false });
  }
  throw new Error("This OpenCode context cannot register custom tools. Install the standard server plugin or configure the browser MCP server.");
}

export async function createOpenCodeSetup(ctx: OpenCodeContext = {}, options: OpenCodeOptions = {}) {
  const runtime = options.runtime ?? ctx.runtime ?? createAgentBrowserRuntime(options);
  const registry = { ...createCoreRegistry(runtime), ...(options.memory ?? memoryEnabledForServer() ? createMemoryRegistry(runtime) : {}) };
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

const opencodeV2Plugin = Object.freeze({
  id: PLUGIN_NAME, name: PLUGIN_NAME, version: PLUGIN_VERSION,
  setup: createOpenCodeSetup, metadata: contractMetadata(),
});

async function opencodeBrowserPluginEntry(ctx: OpenCodeContext = {}, options: OpenCodeOptions = {}) {
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
