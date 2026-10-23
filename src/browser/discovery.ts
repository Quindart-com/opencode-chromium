import { z } from "zod";
import type { BrowserContext } from "../core/tool-definition.ts";
import type { PageCdpRequest } from "../shared/cdp.ts";
import { record } from "../shared/values.ts";
import { safeNetworkUrl } from "./network.ts";
import { defineObjectOperation } from "./operation-definition.ts";
import { assertNavigationAllowed } from "./url-policy.ts";

export function boundedFrameTree(tree: unknown, { maxDepth = 3, maxFrames = 20 } = {}) {
  const frames: { frameId: string; parentId: string | null; depth: number; url: string }[] = [];
  const pending: { tree: unknown; depth: number; parentId: string | null }[] = [{ tree, depth: 0, parentId: null }];
  let truncated = false;
  while (pending.length && frames.length < maxFrames) {
    const current = pending.shift();
    if (!current) break;
    const value = record(current.tree), frame = record(value.frame);
    if (typeof frame.id !== "string" || !frame.id) continue;
    frames.push({ frameId: frame.id, parentId: current.parentId, depth: current.depth, url: typeof frame.url === "string" ? frame.url : "about:blank" });
    if (value.truncated) truncated = true;
    const children = Array.isArray(value.childFrames) ? value.childFrames : [];
    if (current.depth < maxDepth) {
      for (const child of children) {
        if (pending.length >= maxFrames) { truncated = true; break; }
        pending.push({ tree: child, depth: current.depth + 1, parentId: frame.id });
      }
    } else if (children.length) truncated = true;
  }
  return { frames, truncated: truncated || pending.length > 0, maxDepth, maxFrames };
}

export function webMcpDiscoveryExpression({ limit = 20, maxSchemaChars = 2000 } = {}) {
  return `(async () => {
    const api = document.modelContext?.getTools ? document.modelContext : navigator.modelContext;
    const testing = navigator.modelContextTesting;
    const list = typeof api?.getTools === 'function' ? () => api.getTools({fromOrigins: []})
      : typeof testing?.listTools === 'function' ? () => testing.listTools() : null;
    if (!list) return { supported: false, tools: [], reason: 'WebMCP discovery is unavailable in this browser or page.' };
    let timer;
    try {
      const source = await Promise.race([Promise.resolve().then(list), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('WebMCP discovery timed out')), 1000); })]);
      if (!Array.isArray(source)) throw Error('WebMCP returned an invalid tool list');
      const compact = (value, cap) => typeof value === 'string' ? value.slice(0, cap) : '';
      const schema = (value, depth = 0) => {
        if (depth > 4) return null;
        if (value === null || ['boolean','number','string'].includes(typeof value)) return typeof value === 'string' ? value.slice(0, 300) : value;
        if (Array.isArray(value)) return value.slice(0, 20).map(v => schema(v, depth + 1));
        if (typeof value !== 'object') return null;
        return Object.fromEntries(Object.keys(value).slice(0, 20).filter(k => !['__proto__', 'constructor', 'prototype'].includes(k)).map(k => [k.slice(0, 80), schema(value[k], depth + 1)]));
      };
      const tools = [];
      for (const item of source.slice(0, ${limit})) {
        if (!item || typeof item.name !== 'string') continue;
        const inputSchema = JSON.stringify(schema(item.inputSchema ?? {}));
        tools.push({ name: compact(item.name, 128), description: compact(item.description, 500), origin: compact(item.origin ?? location.origin, 300),
          inputSchema: inputSchema.length <= ${maxSchemaChars} ? JSON.parse(inputSchema) : null, schemaTruncated: inputSchema.length > ${maxSchemaChars} });
      }
      return { supported: true, source: api?.getTools ? 'modelContext.getTools' : 'modelContextTesting.listTools', tools, truncated: source.length > ${limit}, untrusted: true, executionEnabled: false };
    } finally { clearTimeout(timer); }
  })()`;
}

type FrameInput = { tabId: number; maxDepth: number; maxFrames: number };
export function createDiscoveryOperations({ command, evaluate, getTab }: {
  command: PageCdpRequest;
  evaluate(context: BrowserContext, tabId: number, expression: string, options?: { timeoutMs?: number }): Promise<unknown>;
  getTab(context: BrowserContext, tabId: number): Promise<{ url?: string }>;
}) {
  const tabId = z.number().int().positive();
  const frameArgs = { tabId, maxDepth: z.number().int().min(0).max(8).default(3), maxFrames: z.number().int().min(1).max(50).default(20) };
  const readFrames = async (args: FrameInput, context: BrowserContext) => {
    const tab = await getTab(context, args.tabId);
    assertNavigationAllowed(tab.url ?? "about:blank", context.urlPolicy);
    const tree = await command(context, args.tabId, "Page.getFrameTree", { maxDepth: args.maxDepth, maxFrames: args.maxFrames });
    return boundedFrameTree(tree.frameTree, args);
  };
  return {
    browser_frames: defineObjectOperation({ capabilityOnly: true, args: frameArgs, async execute(args, context) {
      const result = await readFrames(args, context);
      return { ...result, frames: result.frames.map(frame => ({ ...frame, url: safeNetworkUrl(frame.url), allowed: context.urlPolicy?.evaluate(frame.url).allowed ?? true })) };
    } }),
    browser_frame_inspect: defineObjectOperation({ capabilityOnly: true, args: { ...frameArgs, frameId: z.string().min(1).max(300), maxChars: z.number().int().min(256).max(10000).default(2000) }, async execute(args, context) {
      const tree = await readFrames(args, context), frame = tree.frames.find(item => item.frameId === args.frameId);
      if (!frame) throw Object.assign(new Error("Frame is missing or outside traversal limits; discover frames again."), { code: "FRAME_NOT_FOUND", uncertain: false, retryable: false });
      assertNavigationAllowed(frame.url, context.urlPolicy);
      const world = await command(context, args.tabId, "Page.createIsolatedWorld", { frameId: frame.frameId, worldName: "opencode-frame-inspection" });
      const response = await command(context, args.tabId, "Runtime.evaluate", { contextId: world.executionContextId, returnByValue: true,
        expression: `JSON.stringify({url:location.href,title:document.title.slice(0,200),text:(document.body?.innerText??'').slice(0,${args.maxChars}),truncated:(document.body?.innerText.length??0)>${args.maxChars}})` });
      if (response.exceptionDetails || typeof response.result?.value !== "string") throw new Error("Frame changed during inspection; discover frames again.");
      const value = z.object({ url: z.string(), title: z.string(), text: z.string(), truncated: z.boolean() }).parse((JSON.parse(response.result.value) as unknown));
      assertNavigationAllowed(value.url, context.urlPolicy);
      return { frameId: frame.frameId, ...value, url: safeNetworkUrl(value.url) };
    } }),
    browser_webmcp_discover: defineObjectOperation({ capabilityOnly: true, args: { tabId, limit: z.number().int().min(1).max(30).default(20), maxSchemaChars: z.number().int().min(100).max(3000).default(2000) }, async execute(args, context) {
      const tab = await getTab(context, args.tabId);
      assertNavigationAllowed(tab.url ?? "about:blank", context.urlPolicy);
      const value = z.looseObject({ tools: z.array(z.looseObject({ origin: z.string() })).default([]) }).parse(await evaluate(context, args.tabId, webMcpDiscoveryExpression(args), { timeoutMs: 2000 }));
      const current = await getTab(context, args.tabId);
      if (current.url !== tab.url) throw new Error("Page navigated during discovery; retry on the current page.");
      return { ...value, tools: (value.tools ?? []).filter((tool) => context.urlPolicy?.evaluate(tool.origin).allowed ?? true) };
    } }),
  };
}
