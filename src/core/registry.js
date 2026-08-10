import { z } from "zod";

const sessionFields = {
  sessionId: z.string().min(1).max(160).optional(),
  profile: z.string().min(1).max(160).optional(),
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
  nodeId: z.string().optional(),
  selector: z.string().optional(),
  query: z.string().optional(),
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
  fullPage: z.boolean().optional(),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  quality: z.number().int().min(0).max(100).optional(),
  diagnostic: diagnosticSchema.optional(),
  searchStrategy: z.enum(["snowflake", "auto", "lexical", "deep"]).optional(),
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
  input: z.any().optional(),
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
  fullPage: z.boolean().optional(),
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
});

const resultSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  sessionId: z.string(),
  error: errorSchema.optional(),
}).passthrough();

export function createCoreRegistry(runtime) {
  return {
    browser_run: {
      description: "Run an action chain with settle and post-observation.",
      inputSchema: z.object({
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
      }),
      outputSchema: resultSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
      execute: (args, context) => runtime.run(args, context),
    },
    browser_observe: {
      description: "Observe compact browser evidence.",
      inputSchema: z.object({
        ...sessionFields,
        mode: z.enum(["search", "inspect", "visual", "extract", "events", "downloads", "screenshot", "raw-snapshot", "capabilities", "artifact", "diagnostic"]),
        tabId: z.number().int().positive().optional(),
        target: targetSchema,
        query: z.string().optional(),
        detail: z.enum(["lean", "compact", "full", "debug"]).optional(),
        limit: z.number().int().positive().optional(),
        fullPage: z.boolean().optional(),
        format: z.enum(["png", "jpeg", "webp"]).optional(),
        quality: z.number().int().min(0).max(100).optional(),
        delivery: z.enum(["artifact", "inline"]).optional(),
        searchStrategy: z.enum(["snowflake", "auto", "lexical", "deep"]).optional(),
        pack: z.string().max(64).optional(),
        uri: z.string().max(300).optional(),
        diagnostic: diagnosticSchema.optional(),
        maxChars: z.number().int().positive().optional(),
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      execute: (args, context) => runtime.observe(args, context),
    },
    browser_session: {
      description: "Manage a named-profile browser session.",
      inputSchema: z.object({
        ...sessionFields,
        action: z.enum(["open", "new-tab", "claim-tab", "release-tab", "name", "configure"]),
        tabId: z.number().int().positive().optional(),
        name: z.string().min(1).max(120).optional(),
        scope: z.enum(["session", "user"]).optional(),
        environment: environmentSchema.optional(),
      }),
      outputSchema: resultSchema,
      annotations: { openWorldHint: true },
      execute: (args, context) => runtime.session(args, context),
    },
    browser_finalize: {
      description: "Finalize a browser session.",
      inputSchema: z.object({
        ...sessionFields,
        keep: z.array(z.union([
          z.number().int().positive(),
          z.object({ tabId: z.number().int().positive(), status: z.enum(["handoff", "deliverable"]).optional() }),
        ])).max(50).optional(),
        keepEnvironment: z.boolean().optional().describe("Retain applied emulation overrides instead of clearing them."),
      }),
      outputSchema: resultSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
      execute: (args, context) => runtime.finalize(args, context),
    },
  };
}

export { environmentSchema, observationSchema, resultSchema, settleSchema, stepSchema, targetSchema };
