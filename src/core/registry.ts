import { z } from "zod";
import { defineRuntimeTool,type BrowserContext } from "./tool-definition.ts";

const sessionFields = {
  sessionId: z.string().min(1).max(160).nullable().optional(),
  profile: z.string().min(1).max(160).nullable().optional(),
};

const networkPresetSchema = z.enum(["offline", "slow-2g", "slow-3g", "fast-3g", "slow-4g", "online"]);
const networkConditionsSchema = z.object({
  offline: z.boolean().optional(),
  latency: z.number().min(0).optional(),
  downloadThroughput: z.number().optional(),
  uploadThroughput: z.number().optional(),
});

const environmentSchema = z.object({
  reset: z.boolean().optional(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().min(0).optional(),
    mobile: z.boolean().optional(),
    touch: z.boolean().optional(),
  }).optional(),
  network: z.union([networkPresetSchema, networkConditionsSchema]).optional(),
  cpuThrottling: z.number().min(1).optional(),
  colorScheme: z.enum(["light", "dark", "no-preference"]).optional(),
  geolocation: z.object({
    latitude: z.number(),
    longitude: z.number(),
    accuracy: z.number().min(0).optional(),
  }).optional(),
  userAgent: z.string().max(500).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  initScripts: z.array(z.string().max(20000)).max(50).optional(),
});

const targetSchema = z.object({
  frameId: z.string().min(1).max(300).optional(),
  nodeId: z.string().optional(),
  selector: z.string().optional(),
  query: z.string().optional(),
  role: z.string().max(64).optional(),
  fromStep: z.string().optional(),
  index: z.number().int().min(0).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  requestId: z.string().optional(),
}).optional();

const settleSchema = z.object({
  condition: z.enum(["dom-quiet", "exists", "not-exists", "contains"]),
  target: targetSchema,
  value: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).optional();

const diagnosticSchema = z.object({
  type: z.enum(["performance"]),
  action: z.enum(["record", "inspect"]),
  reload: z.boolean().optional(),
  durationMs: z.number().int().positive().max(30000).optional(),
  waitUntil: z.enum(["none", "domcontentloaded", "load"]).optional(),
  timeoutMs: z.number().int().positive().max(120000).optional(),
  artifact: z.string().max(300).optional(),
  insight: z.string().max(120).optional(),
  url: z.string().max(500).optional(),
});

const observationSchema = z.object({
  mode: z.enum(["search", "inspect", "visual", "extract", "events", "downloads", "screenshot", "raw-snapshot", "capabilities", "artifact", "diagnostic"]),
  target: targetSchema,
  query: z.string().optional(),
  pack: z.string().max(64).optional(),
  uri: z.string().max(300).optional(),
  detail: z.enum(["lean", "compact", "full", "debug"]).optional(),
  limit: z.number().int().positive().optional(),
  fullPage: z.boolean().optional().describe("true captures the full scrollable page; false captures the visible viewport."),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  quality: z.number().int().min(0).max(100).optional(),
  diagnostic: diagnosticSchema.optional(),
  searchStrategy: z.enum(["auto", "semantic", "lexical", "deep"]).optional(),
}).optional();

const stepSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(),
  action: z.enum([
    "navigate", "reload", "back", "forward", "find", "click", "doubleClick", "hover", "focus",
    "fill", "replaceText", "fillForm", "type", "press", "select", "scroll", "drag",
    "assert", "upload", "clipboardRead", "clipboardWrite", "handleDialog", "screenshot", "close", "capability",
  ]),
  target: targetSchema,
  url: z.string().url().refine((value) => /^https?:\/\//i.test(value) || value === "about:blank", {
    message: "Navigation supports http://, https://, and about:blank only",
  }).optional(),
  value: z.string().optional(),
  promptText: z.string().max(2000).optional(),
  capability: z.string().max(160).optional(),
  input: z.unknown().optional(),
  key: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
  files: z.array(z.string()).max(20).optional(),
  path: z.array(z.object({ x: z.number(), y: z.number() })).max(100).optional(),
  scrollX: z.number().optional(),
  scrollY: z.number().optional(),
  button: z.enum(["left", "middle", "right"]).optional(),
  waitUntil: z.enum(["none", "domcontentloaded", "load"]).optional(),
  condition: z.enum(["exists", "not-exists", "contains", "equals"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  settle: settleSchema,
  delivery: z.enum(["artifact", "inline"]).optional(),
  fullPage: z.boolean().optional().describe("true captures the full scrollable page; false captures the visible viewport."),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  quality: z.number().int().min(0).max(100).optional(),
  retry: z.number().int().min(0).max(3).optional(),
  onError: z.enum(["stop", "continue"]).optional(),
  bypassCache: z.boolean().optional(),
});

const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  uncertain: z.boolean(),
}).passthrough();

const resultSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  sessionId: z.string(),
  error: errorSchema.optional(),
}).passthrough();

export const runInputSchema = z.object({
        ...sessionFields,
        tab: z.object({
          mode: z.enum(["current", "new", "claim"]).optional(),
          tabId: z.number().int().positive().optional(),
        }).optional(),
        steps: z.array(stepSchema).max(20).optional(),
        approvalToken: z.string().optional(),
        postObserve: observationSchema,
        returnMode: z.enum(["last", "all", "summary"]).optional(),
        maxChars: z.number().int().positive().optional(),
        memoryMode: z.enum(["auto", "off"]).optional().describe("auto (default) = replay a remembered recipe for these exact steps first; off = never consult memory."),
        memoryIntent: z.string().min(1).max(512).optional().describe("Optional recipe-selection intent. Uses Jev if enabled, then local recall. Never stored."),
      });
export type RunInput = z.output<typeof runInputSchema>;

export const observeInputSchema = z.object({
        ...sessionFields,
        mode: z.enum(["search", "inspect", "visual", "extract", "events", "downloads", "screenshot", "raw-snapshot", "capabilities", "artifact", "diagnostic"]),
        tabId: z.number().int().positive().optional(),
        target: targetSchema,
        query: z.string().optional(),
        detail: z.enum(["lean", "compact", "full", "debug"]).optional(),
        limit: z.number().int().positive().optional(),
        fullPage: z.boolean().optional().describe("true captures the full scrollable page; false captures the visible viewport."),
        format: z.enum(["png", "jpeg", "webp"]).optional(),
        quality: z.number().int().min(0).max(100).optional(),
        delivery: z.enum(["artifact", "inline"]).optional(),
        searchStrategy: z.enum(["auto", "semantic", "lexical", "deep"]).optional(),
        pack: z.string().max(64).optional(),
        uri: z.string().max(300).optional(),
        diagnostic: diagnosticSchema.optional(),
        maxChars: z.number().int().positive().optional(),
      });
export type ObserveInput = z.output<typeof observeInputSchema>;

export const sessionInputSchema = z.object({
        ...sessionFields,
        action: z.enum(["open", "new-tab", "claim-tab", "release-tab", "name", "configure"]),
        tabId: z.number().int().positive().optional(),
        name: z.string().min(1).max(120).optional(),
        scope: z.enum(["session", "user"]).optional(),
        environment: environmentSchema.optional(),
      });
export type SessionInput = z.output<typeof sessionInputSchema>;

export const finalizeInputSchema = z.object({
        ...sessionFields,
        keep: z.array(z.union([
          z.number().int().positive(),
          z.object({ tabId: z.number().int().positive(), status: z.enum(["handoff", "deliverable"]).optional().describe("Default: deliverable, open in a blue review group. Explicit handoff retains session ownership for later work.") }),
        ])).max(50).optional(),
        keepEnvironment: z.boolean().optional().describe("Retain applied emulation overrides instead of clearing them."),
      });
export type FinalizeInput = z.output<typeof finalizeInputSchema>;

export const memoryStatusInputSchema = z.object({ ...sessionFields, profileIds: z.array(z.string().min(1).max(160)).max(50).optional(), includeUnattributed: z.boolean().optional() });
export type MemoryStatusInput = z.output<typeof memoryStatusInputSchema>;

export const memoryQueryInputSchema = z.object({
        ...sessionFields,
        limit: z.number().int().min(1).max(200).optional(),
        capability: z.string().min(1).max(128).optional(),
        hostname: z.string().min(1).max(255).optional(),
        session_id: z.string().min(1).max(256).optional(),
        since_id: z.number().int().min(1).optional(),
        until_id: z.number().int().min(1).optional(),
      });
export type MemoryQueryInput = z.output<typeof memoryQueryInputSchema>;

export const memorySearchInputSchema = z.object({
        ...sessionFields,
        query: z.string().min(1).max(512),
        limit: z.number().int().min(1).max(20).optional(),
        kind: z.enum(["all", "action", "chain"]).optional(),
        hostname: z.string().min(1).max(255).optional(),
      });
export type MemorySearchInput = z.output<typeof memorySearchInputSchema>;

export interface RuntimePort {
  run(input: RunInput, context: BrowserContext): unknown | Promise<unknown>;
  observe(input: ObserveInput, context: BrowserContext): unknown | Promise<unknown>;
  session(input: SessionInput, context: BrowserContext): unknown | Promise<unknown>;
  finalize(input: FinalizeInput, context: BrowserContext): unknown | Promise<unknown>;
  memoryStatus(input: MemoryStatusInput, context: BrowserContext): unknown | Promise<unknown>;
  memoryQuery(input: MemoryQueryInput, context: BrowserContext): unknown | Promise<unknown>;
  memorySearch(input: MemorySearchInput, context: BrowserContext): unknown | Promise<unknown>;
}

export function createCoreRegistry(runtime: Pick<RuntimePort, "run" | "observe" | "session" | "finalize">) {
  return {
    browser_run: defineRuntimeTool({
      description: "Run an action chain with settle and post-observation. If authorization is blocked, ask Approve / Disapprove with the harness question tool.",
      inputSchema: runInputSchema,
      outputSchema: resultSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
      execute: (args, context) => runtime.run(args, context),
    }),
    browser_observe: defineRuntimeTool({
      description: "Observe compact browser evidence.",
      inputSchema: observeInputSchema,
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      execute: (args, context) => runtime.observe(args, context),
    }),
    browser_session: defineRuntimeTool({
      description: "Manage a named-profile session. Name labels its tab group. scope=user lists only ungrouped, unclaimed tabs; claim-tab needs the user's request or permission.",
      inputSchema: sessionInputSchema,
      outputSchema: resultSchema,
      annotations: { openWorldHint: true },
      execute: (args, context) => runtime.session(args, context),
    }),
    browser_finalize: defineRuntimeTool({
      description: "Finish work: leave all tabs open for human review in a blue group and release ownership. Only explicit keep status 'handoff' retains a tab in the active session.",
      inputSchema: finalizeInputSchema,
      outputSchema: resultSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
      execute: (args, context) => runtime.finalize(args, context),
    }),
  };
}

export function createMemoryRegistry(runtime: Pick<RuntimePort, "memoryStatus" | "memoryQuery" | "memorySearch">) {
  return {
    memory_status: defineRuntimeTool({
      description: "Report local action-memory availability: capture state, model, quota, purge settings, and success-rate statistics. Read-only; reveals no memory content.",
      inputSchema: memoryStatusInputSchema,
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      execute: (args, context) => runtime.memoryStatus(args, context),
    }),
    memory_query: defineRuntimeTool({
      description: "Return bounded metadata-only signatures recorded for prior browser sessions (capability, hostname, bounded label, confirmed and failed counts) so a continued run can pick up where an earlier one left off. Never includes URLs, paths, typed text, arguments, results, or window titles. Results may enter model context.",
      inputSchema: memoryQueryInputSchema,
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      execute: (args, context) => runtime.memoryQuery(args, context),
    }),
    memory_search: defineRuntimeTool({
      description: "Semantically search local action memory: embed the query and return the top-k matching actions or ready-to-run chains, ranked by similarity times confidence. Confirmed actions rank above repeated failures; failures return with a failed-count badge as negative lessons. Query text is never stored.",
      inputSchema: memorySearchInputSchema,
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      execute: (args, context) => runtime.memorySearch(args, context),
    }),
  };
}

export { environmentSchema,observationSchema,resultSchema,settleSchema,stepSchema,targetSchema };

export type Step = z.output<typeof stepSchema>;
export type Target = NonNullable<z.output<typeof targetSchema>>;
export type Environment = z.output<typeof environmentSchema>;
export type Observation = NonNullable<z.output<typeof observationSchema>>;
