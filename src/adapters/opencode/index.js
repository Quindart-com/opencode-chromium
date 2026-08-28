import { tool as openCodeTool } from "@opencode-ai/plugin";
import { define } from "@opencode-ai/plugin/v2/promise";
import { Buffer } from "node:buffer";
import { createAgentBrowserRuntime } from "../../core/runtime.js";
import { createCoreRegistry, createMemoryRegistry } from "../../core/registry.js";
import { dispatchBrowserTool, jsonSchemaFor } from "../../core/schema-adapters.js";
import { contractMetadata, PLUGIN_NAME, PLUGIN_VERSION } from "../../core/versions.js";
import { createLogger } from "../../core/logging.js";
import { memoryEnabledForServer } from "../../memory/index.js";

const IMAGE_EXTENSION_BY_MIME = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const IMAGE_ATTACHMENT_LIMIT = 4;

function inlineImagePayload(value) {
  return typeof value?.base64 === "string" && typeof value?.mimeType === "string" && value.mimeType.startsWith("image/") ? value : null;
}

function* imageCandidates(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return;
  const inline = inlineImagePayload(value);
  if (inline) {
    yield inline;
    return;
  }
  if (typeof value.mimeType === "string" && value.mimeType.startsWith("image/") && !value.base64 && (value.artifactId || value.uri)) {
    yield value;
    return;
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const entry of child) yield* imageCandidates(entry, depth + 1);
    } else if (child && typeof child === "object") {
      yield* imageCandidates(child, depth + 1);
    }
  }
}

function toAttachment(mimeType, data) {
  if (!data) return null;
  const extension = IMAGE_EXTENSION_BY_MIME[mimeType] ?? "png";
  return {
    type: "file",
    mime: mimeType,
    filename: `screenshot.${extension}`,
    url: `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`,
  };
}

function imageAttachments(result, runtime) {
  try {
    const attachments = [];
    for (const candidate of imageCandidates(result)) {
      if (attachments.length >= IMAGE_ATTACHMENT_LIMIT) break;
      if (typeof candidate.base64 === "string") {
        const attachment = toAttachment(candidate.mimeType, Buffer.from(candidate.base64, "base64"));
        if (attachment) attachments.push(attachment);
      } else if (runtime?.artifacts) {
        const artifact = runtime.artifacts.read(candidate.artifactId ?? candidate.uri);
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

function sanitizeImagePayloads(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeImagePayloads(entry, depth + 1));
  const inline = inlineImagePayload(value);
  if (inline) {
    const { base64, ...rest } = inline;
    return { ...rest, base64Bytes: Math.floor(base64.replace(/=+$/, "").length * 0.75), imageDelivery: "attachment" };
  }
  const output = {};
  for (const [key, child] of Object.entries(value)) output[key] = sanitizeImagePayloads(child, depth + 1);
  return output;
}

function concise(result) {
  const text = JSON.stringify(sanitizeImagePayloads(result));
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
        attachments: imageAttachments(result, runtime),
        metadata: { ...contractMetadata(), tool: name, sessionId: result.sessionId ?? null },
      };
    },
  });
}

function createLegacyOpenCodeHooks(options = {}) {
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
